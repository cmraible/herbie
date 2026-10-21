import Foundation

struct APIError: LocalizedError {
  var status: Int
  var message: String
  var code: String?
  var errorDescription: String? { message }
}
struct API: Sendable {
  let baseURL: URL
  var token: String?
  var session: URLSession = .shared

  static func serviceURL(_ value: String) throws -> URL {
    guard let c = URLComponents(string: value.trimmingCharacters(in: .whitespacesAndNewlines)),
      c.scheme == "https", c.host?.isEmpty == false, c.user == nil, c.password == nil,
      c.query == nil, c.fragment == nil, c.path.isEmpty || c.path == "/",
      let url = c.url
    else {
      throw APIError(
        status: 0, message: "Enter an HTTPS service URL without a path, credentials, or query.")
    }
    return url
  }
  private struct Failure: Decodable {
    var error: String
    var code: String?
  }
  func request<T: Decodable & Sendable>(
    _ path: String, body: [String: JSONValue]? = nil,
    requestId: String? = nil, preparation: String? = nil
  ) async throws -> T {
    guard let url = URL(string: path, relativeTo: baseURL)?.absoluteURL,
      url.host == baseURL.host, url.scheme == baseURL.scheme
    else {
      throw APIError(status: 0, message: "Invalid service endpoint.")
    }
    var request = URLRequest(url: url, timeoutInterval: 30)
    request.httpMethod = body == nil ? "GET" : "POST"
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    request.setValue("2", forHTTPHeaderField: "x-herbie-repository-version")
    if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
    if let body {
      request.setValue(
        baseURL.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/")),
        forHTTPHeaderField: "Origin")
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
      request.httpBody = try JSONEncoder().encode(body)
    }
    request.setValue(requestId, forHTTPHeaderField: "Idempotency-Key")
    request.setValue(preparation, forHTTPHeaderField: "x-herbie-environment-preparation")
    let (data, response) = try await session.data(for: request)
    guard let response = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
    guard (200..<300).contains(response.statusCode) else {
      let failure = try? JSONDecoder().decode(Failure.self, from: data)
      throw APIError(
        status: response.statusCode,
        message: failure?.error ?? "Service returned HTTP \(response.statusCode).",
        code: failure?.code)
    }
    return try JSONDecoder().decode(T.self, from: data)
  }
  func save(_ draft: ProjectDraft, projectID: String?, progress: @Sendable (String) async -> Void)
    async throws -> Project
  {
    let path = projectID.map { "/api/projects/\($0)" } ?? "/api/projects"
    let requestID = projectID == nil ? draft.requestId : nil
    do {
      return try await request(
        path, body: draft.body(editing: projectID != nil), requestId: requestID)
    } catch let error as APIError where error.code == "environment_preparation_required" {}
    await progress("Preparing environment…")
    var body: [String: JSONValue] = ["resources": draft.body(editing: false)["resources"] ?? .null]
    if let projectID {
      body["projectId"] = .string(projectID)
    } else {
      body["repository"] = .string(draft.repository)
    }
    var preparation: Preparation = try await request("/api/project-environments", body: body)
    let deadline = Date().addingTimeInterval(16 * 60)
    while preparation.state == "building" {
      guard Date() < deadline else {
        throw APIError(status: 504, message: "Environment preparation timed out. Retry saving.")
      }
      try await Task.sleep(for: .seconds(2))
      preparation = try await request("/api/project-environments/\(preparation.id)")
    }
    guard preparation.state == "ready" else {
      throw APIError(
        status: 502, message: "Environment preparation failed. Retry saving your project.")
    }
    await progress("Saving project…")
    return try await request(
      path, body: draft.body(editing: projectID != nil), requestId: requestID,
      preparation: preparation.id)
  }
  func events(projectID: String) async throws -> [ProjectEvent] {
    // Re-read all pages: sequence IDs may commit out of order on the service.
    var result: [ProjectEvent] = []
    var cursor = 0
    while true {
      let page: [ProjectEvent] = try await request(
        "/api/projects/\(projectID)/events?after=\(cursor)")
      result.append(contentsOf: page)
      guard page.count >= 1000, let last = page.last, last.id > cursor else { return result }
      cursor = last.id
    }
  }
}
