import Security
import SwiftUI

@MainActor @Observable final class Workspace {
  var api: API?
  var user: Session.User?
  var projects: [Project] = []
  var selectedProjectID: String?
  var projectEvents: [String: [ProjectEvent]] = [:]
  var repositories: [Repository] = []
  var permissionsRequired = false
  var error: String?
  var loading = false
  var busy = false
  var refreshing = false
  var approval: AuthStart?
  var isPreview = false

  init() {
    #if DEBUG
      if ProcessInfo.processInfo.arguments.contains("--preview") {
        isPreview = true
        user = Session.User(id: "preview", login: "Preview workspace")
        projects = PreviewData.projects
      }
    #endif
  }
  var service = UserDefaults.standard.string(forKey: "serviceURL") ?? ""

  func connect() async {
    guard !isPreview else { return }
    loading = true
    defer { loading = false }
    do {
      let url = try API.serviceURL(service)
      let client = API(baseURL: url, token: try Keychain.read(url.absoluteString))
      api = client
      if client.token != nil { try await loadSession() }
    } catch { self.error = error.localizedDescription }
  }
  func loadSession() async throws {
    guard let api else { return }
    let result: Session = try await api.request("/api/session")
    user = result.user
    try await reload()
  }
  func reload() async throws {
    guard let api, user != nil, !refreshing else { return }
    refreshing = true
    defer { refreshing = false }
    do {
      let result: [Project] = try await api.request("/api/projects")
      projects = result
      if let selectedProjectID {
        projectEvents[selectedProjectID] = try await api.events(projectID: selectedProjectID)
      }
    } catch let failure as APIError where failure.status == 401 {
      user = nil
      projects = []
      projectEvents = [:]
      selectedProjectID = nil
      repositories = []
      throw failure
    }
  }
  func discover() async throws {
    guard let api else { return }
    let result: Discovery = try await api.request("/api/repositories")
    repositories = result.repositories
    permissionsRequired = result.permissionsRequired
  }
  func beginLogin() async {
    await perform {
      let url = try API.serviceURL(self.service)
      self.api = API(baseURL: url)
      let approval: AuthStart = try await self.api!.request(
        "/api/auth/start", body: ["client": .string("cli")])
      guard approval.pollToken != nil, approval.userCode != nil else {
        throw APIError(
          status: 0,
          message:
            "Service did not provide a device approval code. Update the service and try again.")
      }
      self.approval = approval
    }
  }
  func finishLogin() async {
    guard let api, let pollToken = approval?.pollToken else { return }
    do {
      for _ in 0..<150 {
        try Task.checkCancellation()
        let query = URLQueryItem(name: "token", value: pollToken)
        var c = URLComponents()
        c.queryItems = [query]
        let result: AuthPoll = try await api.request(
          "/api/auth/poll?" + (c.percentEncodedQuery ?? ""))
        switch result.status {
        case "complete":
          guard let token = result.token else {
            throw APIError(status: 0, message: "Service returned no session.")
          }
          let authenticated = API(baseURL: api.baseURL, token: token)
          let session: Session = try await authenticated.request("/api/session")
          try Keychain.write(token, account: api.baseURL.absoluteString)
          UserDefaults.standard.set(api.baseURL.absoluteString, forKey: "serviceURL")
          self.api = authenticated
          user = session.user
          approval = nil
          try await reload()
          return
        case "expired", "rejected":
          throw APIError(status: 0, message: "Sign-in \(result.status). Please try again.")
        default: try await Task.sleep(for: .seconds(2))
        }
      }
      throw APIError(status: 0, message: "Sign-in timed out. Please try again.")
    } catch is CancellationError {} catch {
      self.error = error.localizedDescription
      approval = nil
    }
  }
  func logout() async {
    await perform {
      guard let api = self.api else { return }
      let _: Acknowledgement = try await api.request("/api/auth/logout", body: [:])
      try Keychain.write(nil, account: api.baseURL.absoluteString)
      self.api = nil
      self.user = nil
      self.projects = []
      self.projectEvents = [:]
      self.selectedProjectID = nil
      self.repositories = []
    }
  }
  func action(_ project: Project, _ action: String, repairID: String? = nil) async {
    await perform {
      guard let api = self.api else { return }
      let updated: Project = try await api.request(
        "/api/projects/\(project.id)/\(action)",
        body: repairID.map { ["repairId": .string($0)] } ?? [:])
      self.upsert(updated)
    }
  }
  func upsert(_ project: Project) {
    if let index = projects.firstIndex(where: { $0.id == project.id }) {
      projects[index] = project
    } else {
      projects.insert(project, at: 0)
    }
  }
  func perform(_ work: () async throws -> Void) async {
    guard !busy else { return }
    busy = true
    defer { busy = false }
    do { try await work() } catch is CancellationError {} catch {
      self.error = error.localizedDescription
    }
  }
}

enum Keychain {
  private static func query(_ account: String) -> [String: Any] {
    [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: "com.herbie.ios.session", kSecAttrAccount as String: account,
    ]
  }
  static func read(_ account: String) throws -> String? {
    var query = query(account)
    query[kSecReturnData as String] = true
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess, let data = result as? Data else { throw failure(status) }
    return String(data: data, encoding: .utf8)
  }
  static func write(_ token: String?, account: String) throws {
    let query = query(account)
    guard let token else {
      let status = SecItemDelete(query as CFDictionary)
      guard status == errSecSuccess || status == errSecItemNotFound else { throw failure(status) }
      return
    }
    let attributes: [String: Any] = [
      kSecValueData as String: Data(token.utf8),
      kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
    ]
    var status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
    if status == errSecItemNotFound {
      status = SecItemAdd(query.merging(attributes) { _, new in new } as CFDictionary, nil)
    }
    guard status == errSecSuccess else { throw failure(status) }
  }
  private static func failure(_ status: OSStatus) -> APIError {
    APIError(
      status: Int(status), message: "Could not access the saved session in Keychain (\(status)).")
  }
}
