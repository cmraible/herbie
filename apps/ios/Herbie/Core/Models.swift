import Foundation

struct Resources: Codable, Equatable, Sendable {
  var cpu: Int
  var memory: Int
  var disk: Int
}
struct Limits: Decodable, Sendable {
  var cpu: Int?
  var memory: Int?
  var disk: Int?
}
struct Project: Codable, Identifiable, Sendable {
  var id: String
  var ownerId: String
  var name: String
  var repository: String
  var prompt: String
  var model: String
  var reasoningEffort: String
  var resources: Resources?
  var workflow: String
  var targetWip: Int
  var state: String
  var attemptCount: Int
  var attempts: [Attempt]?
  var createdAt: String
  var updatedAt: String
  var stopRequested: String?
  var pullRequest: PullRequest?
  var pullRequests: [PullRequest]
  var cleanupStatus: String
  var error: String?

  var finished: Bool { ["completed", "cancelled"].contains(state) }
  var needsAttention: Bool {
    ["failed", "needs_attention"].contains(state) && stopRequested == nil
  }
  var publicationBlocked: Bool {
    error?.hasPrefix("Automatic publication recovery stopped: installation_permissions_missing")
      == true
      || error?.hasPrefix("Automatic publication recovery stopped: workflow_permission_missing")
        == true
  }
  var prs: [PullRequest] { pullRequests.isEmpty ? pullRequest.map { [$0] } ?? [] : pullRequests }
}
struct Attempt: Codable, Identifiable, Sendable {
  var id: String
  var number: Int
  var state: String
  var createdAt: String
  var pullRequest: PullRequest?
  var ciRepair: Repair?
  var sessions: [AgentSession]?
}
struct Repair: Codable, Sendable {
  var id: String
  var state: String
  var canRetry: Bool
}
struct PullRequest: Codable, Identifiable, Sendable {
  var id: Int { number }
  var number: Int
  var url: String
  var state: String
  var branch: String
  var title: String?
  var body: String?
  var draft: Bool?
  var checksPassed: Bool?
  var additions: Int?
  var deletions: Int?
  var changedFiles: Int?
  var ready: Bool { state == "open" && draft == false && checksPassed == true }
}
struct AgentSession: Codable, Identifiable, Sendable {
  var id: String
  var kind: String
  var state: String
  var model: String
  var reasoningEffort: String
  var startedAt: String
  var finishedAt: String?
  var cleanup: String
  var threadId: String?
  var environment: Environment?
  var usage: [String: JSONValue]?
  struct Environment: Codable, Sendable {
    var provider: String
    var id: String
  }
}
struct ProjectEvent: Codable, Identifiable, Sendable {
  var id: Int
  var projectId: String
  var type: String
  var message: String
  var createdAt: String
  var attemptId: String?
  var agentSessionId: String?
}
struct Repository: Decodable, Identifiable, Sendable {
  var id: String { fullName }
  var fullName: String
  var defaultBranch: String
  var installationId: Int
}
struct Discovery: Decodable, Sendable {
  var repositories: [Repository]
  var permissionsRequired: Bool
}
struct Session: Decodable, Sendable {
  var user: User
  struct User: Decodable, Sendable {
    var id: String
    var login: String
  }
}
struct AuthStart: Decodable, Sendable {
  var url: URL
  var pollToken: String?
  var userCode: String?
}
struct AuthPoll: Decodable, Sendable {
  var status: String
  var token: String?
}
struct Preparation: Decodable, Sendable {
  var id: String
  var state: String
}
struct Diff: Decodable, Sendable { var diff: String }
struct Install: Decodable, Sendable { var url: URL }
struct Acknowledgement: Decodable, Sendable { var ok: Bool }

// Preserve arbitrary protocol fields in exported session metadata.
indirect enum JSONValue: Codable, Sendable {
  case string(String)
  case number(Double)
  case bool(Bool)
  case array([JSONValue])
  case object([String: JSONValue])
  case null
  init(from decoder: Decoder) throws {
    let c = try decoder.singleValueContainer()
    if c.decodeNil() {
      self = .null
    } else if let v = try? c.decode(Bool.self) {
      self = .bool(v)
    } else if let v = try? c.decode(Double.self) {
      self = .number(v)
    } else if let v = try? c.decode(String.self) {
      self = .string(v)
    } else if let v = try? c.decode([JSONValue].self) {
      self = .array(v)
    } else {
      self = .object(try c.decode([String: JSONValue].self))
    }
  }
  func encode(to encoder: Encoder) throws {
    var c = encoder.singleValueContainer()
    switch self {
    case .string(let v): try c.encode(v)
    case .number(let v): try c.encode(v)
    case .bool(let v): try c.encode(v)
    case .array(let v): try c.encode(v)
    case .object(let v): try c.encode(v)
    case .null: try c.encodeNil()
    }
  }
}

struct ProjectDraft: Codable, Equatable, Sendable {
  var name = ""
  var repository = ""
  var prompt = ""
  var model = "gpt-6-luna"
  var reasoningEffort = "low"
  var workflow = "loop"
  var targetWip = 1
  var resources: Resources?
  // Survives failed/ambiguous submissions; changing input creates a new request.
  var requestId = UUID().uuidString
  init() {}
  init(_ project: Project) {
    name = project.name
    repository = project.repository
    prompt = project.prompt
    model = project.model
    reasoningEffort = project.reasoningEffort
    workflow = project.workflow
    targetWip = project.targetWip
    resources = project.resources
  }
  static func == (lhs: Self, rhs: Self) -> Bool {
    lhs.name == rhs.name && lhs.repository == rhs.repository && lhs.prompt == rhs.prompt
      && lhs.model == rhs.model && lhs.reasoningEffort == rhs.reasoningEffort
      && lhs.workflow == rhs.workflow && lhs.targetWip == rhs.targetWip
      && lhs.resources == rhs.resources
  }
  var valid: Bool {
    !repository.isEmpty && !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      && prompt.count <= 8000 && name.count <= 120
      && !model.trimmingCharacters(in: .whitespaces).isEmpty && model.count <= 200 && targetWip > 0
      && targetWip <= 2_147_483_647 && (workflow != "single_pr" || targetWip == 1)
      && (resources.map { $0.cpu > 0 && $0.memory > 0 && $0.disk > 0 } ?? true)
  }
  func body(editing: Bool) -> [String: JSONValue] {
    var body: [String: JSONValue] = [
      "prompt": .string(prompt.trimmingCharacters(in: .whitespacesAndNewlines)),
      "model": .string(model.trimmingCharacters(in: .whitespaces)),
      "reasoningEffort": .string(reasoningEffort), "targetWip": .number(Double(targetWip)),
      "resources": resources.map {
        .object([
          "cpu": .number(Double($0.cpu)), "memory": .number(Double($0.memory)),
          "disk": .number(Double($0.disk)),
        ])
      } ?? .null,
    ]
    let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
    if editing || !trimmed.isEmpty { body["name"] = .string(trimmed) }
    if !editing {
      body["repository"] = .string(repository)
      body["workflow"] = .string(workflow)
    }
    return body
  }
}

struct FocusTask: Identifiable {
  var project: Project
  var attempt: Attempt?
  var attention: Bool
  var id: String { project.id + (attempt.map { "/" + $0.id } ?? "") }
  static func queue(_ projects: [Project]) -> [FocusTask] {
    projects.filter { !$0.finished }.flatMap { project -> [FocusTask] in
      let attempts = project.attempts ?? []
      let latest = attempts.filter {
        ["failed", "needs_attention", "publishing"].contains($0.state)
      }.max { $0.number < $1.number }
      var tasks = attempts.compactMap { run -> FocusTask? in
        if let pr = run.pullRequest, pr.state != "open" { return nil }
        let attention =
          (project.needsAttention && latest?.id == run.id)
          || (run.pullRequest?.state == "open" && run.ciRepair?.state == "failed")
        guard attention || run.pullRequest?.ready == true else { return nil }
        return FocusTask(project: project, attempt: run, attention: attention)
      }
      if project.needsAttention && !tasks.contains(where: { $0.attention }) {
        tasks.append(FocusTask(project: project, attention: true))
      }
      return tasks
    }.sorted {
      if $0.attention != $1.attention { return $0.attention }
      let a = $0.attempt?.createdAt ?? $0.project.createdAt
      let b = $1.attempt?.createdAt ?? $1.project.createdAt
      return a == b ? $0.id < $1.id : a < b
    }
  }
}
