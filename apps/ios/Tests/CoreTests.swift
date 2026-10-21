import Foundation
import Testing

@testable import HerbieCore

@Test func serviceOriginValidation() throws {
  #expect(try API.serviceURL("https://herbie.example.com").host == "herbie.example.com")
  for url in [
    "http://example.com", "https://user:secret@example.com", "https://example.com/path",
    "https://example.com?token=secret", "https://example.com#fragment",
  ] {
    #expect(throws: APIError.self) { try API.serviceURL(url) }
  }
}
@Test func workflowPayloadsAndValidation() throws {
  var draft = ProjectDraft()
  draft.repository = "owner/repo"
  draft.prompt = " Fix the issue "
  #expect(draft.valid)
  #expect(draft.body(editing: false)["name"] == nil)
  let body =
    try JSONSerialization.jsonObject(with: JSONEncoder().encode(draft.body(editing: false)))
    as! [String: Any]
  #expect(body["prompt"] as? String == "Fix the issue")
  #expect(body["resources"] is NSNull)
  #expect(draft.body(editing: true)["repository"] == nil)
  #expect(draft.body(editing: true)["workflow"] == nil)
  draft.workflow = "single_pr"
  draft.targetWip = 2
  #expect(!draft.valid)
  draft.targetWip = 1
  draft.resources = Resources(cpu: 0, memory: 8, disk: 10)
  #expect(!draft.valid)
}
@Test func transcriptReplacesDeltasAndKeepsTurnsSeparate() {
  func event(_ id: Int, _ message: String) -> ProjectEvent {
    ProjectEvent(id: id, projectId: "p", type: "agent", message: message, createdAt: "now")
  }
  let events = [
    event(
      1,
      #"{"method":"item/agentMessage/delta","params":{"threadId":"t","turnId":"1","itemId":"a","delta":"Hel"}}"#
    ),
    event(
      2,
      #"{"method":"item/agentMessage/delta","params":{"threadId":"t","turnId":"1","itemId":"a","delta":"lo"}}"#
    ),
    event(
      3,
      #"{"method":"item/completed","params":{"threadId":"t","turnId":"1","item":{"id":"a","type":"agentMessage","text":"Final"}}}"#
    ),
    event(
      4,
      #"{"method":"item/agentMessage/delta","params":{"threadId":"t","turnId":"2","itemId":"a","delta":"Next turn"}}"#
    ),
    event(5, "invalid JSON"),
  ]
  let items = Activity.assemble(events)
  #expect(items.count == 2)
  #expect(items[0].text == "Final")
  #expect(items[1].text == "Next turn")
}
@Test func reasoningBlocksAndCommandOutput() {
  let messages = [
    #"{"method":"item/reasoning/summaryTextDelta","params":{"threadId":"t","turnId":"1","itemId":"a","summaryIndex":0,"delta":"Thinking"}}"#,
    #"{"method":"item/reasoning/textDelta","params":{"threadId":"t","turnId":"1","itemId":"a","contentIndex":0,"delta":"Details"}}"#,
    #"{"method":"item/commandExecution/outputDelta","params":{"threadId":"t","turnId":"1","itemId":"b","delta":"Tests passed"}}"#,
  ]
  let events = messages.enumerated().map {
    ProjectEvent(
      id: $0.offset, projectId: "p", type: "agent", message: $0.element, createdAt: "now")
  }
  let items = Activity.assemble(events)
  #expect(items[0].text == "Thinking\n\nDetails")
  #expect(items[1].text == "Tests passed")
}

// Each transport test has its own URLSession and protocol class; no shared mutable handlers.
final class SaveProtocol: URLProtocol, @unchecked Sendable {
  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer test-session")
    #expect(request.value(forHTTPHeaderField: "x-herbie-repository-version") == "2")
    #expect(request.value(forHTTPHeaderField: "Origin") == "https://herbie.example.com")
    let path = request.url!.path
    var status = 200
    var data: Data
    if path == "/api/project-environments" {
      data = Data(#"{"id":"prepared","state":"ready"}"#.utf8)
    } else if request.value(forHTTPHeaderField: "x-herbie-environment-preparation") == nil {
      #expect(request.value(forHTTPHeaderField: "Idempotency-Key") == "stable-request")
      status = 409
      data = Data(#"{"error":"Prepare first","code":"environment_preparation_required"}"#.utf8)
    } else {
      #expect(request.value(forHTTPHeaderField: "Idempotency-Key") == "stable-request")
      data = Data(projectJSON.utf8)
    }
    client?.urlProtocol(
      self,
      didReceive: HTTPURLResponse(
        url: request.url!, statusCode: status, httpVersion: nil,
        headerFields: ["Content-Type": "application/json"])!, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: data)
    client?.urlProtocolDidFinishLoading(self)
  }
  override func stopLoading() {}
}
private let projectJSON =
  #"{"id":"p","ownerId":"owner","name":"Fix","repository":"owner/repo","prompt":"Fix","model":"gpt-6-luna","reasoningEffort":"low","workflow":"loop","targetWip":1,"state":"queued","attemptCount":0,"createdAt":"2026-10-20","updatedAt":"2026-10-20","pullRequests":[],"cleanupStatus":"not_required"}"#
@Test func environmentPreparationRetainsIdempotencyAndAuth() async throws {
  let config = URLSessionConfiguration.ephemeral
  config.protocolClasses = [SaveProtocol.self]
  let session = URLSession(configuration: config)
  defer { session.invalidateAndCancel() }
  let api = API(
    baseURL: URL(string: "https://herbie.example.com")!, token: "test-session", session: session)
  var draft = ProjectDraft()
  draft.repository = "owner/repo"
  draft.prompt = "Fix"
  draft.requestId = "stable-request"
  let project = try await api.save(draft, projectID: nil) { _ in }
  #expect(project.id == "p")
}
@Test func focusQueuePrioritizesAttentionAndExcludesFinished() throws {
  var failed = try JSONDecoder().decode(Project.self, from: Data(projectJSON.utf8))
  failed.state = "failed"
  var done = failed
  done.id = "done"
  done.state = "completed"
  #expect(FocusTask.queue([done, failed]).map(\.project.id) == ["p"])
  failed.stopRequested = "pause"
  #expect(FocusTask.queue([failed]).isEmpty)
}
