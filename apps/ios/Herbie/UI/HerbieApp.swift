import SwiftUI

@main struct HerbieApp: App {
  @State private var workspace = Workspace()
  var body: some Scene {
    WindowGroup { RootView().environment(workspace).tint(.green) }
  }
}
struct RootView: View {
  @Environment(Workspace.self) private var store
  @Environment(\.scenePhase) private var phase
  @State private var selection: String?
  @State private var query = ""
  @State private var focus = false
  @State private var finished = false
  @State private var creating = false
  @State private var settings = false
  var body: some View {
    @Bindable var store = store
    Group {
      if store.user == nil {
        LoginView()
      } else {
        NavigationSplitView {
          List(selection: $selection) {
            Section {
              Toggle("Focus queue", isOn: $focus)
              if !focus { Toggle("Show finished", isOn: $finished) }
            }
            if focus {
              let tasks = FocusTask.queue(store.projects)
              Section("\(tasks.count) tasks to review") {
                ForEach(tasks) { task in
                  NavigationLink(value: task.id) {
                    ProjectRow(
                      project: task.project,
                      subtitle: task.attempt.map { "Run \($0.number) · \(label($0.state))" })
                  }
                }
              }
              if tasks.isEmpty {
                ContentUnavailableView(
                  "All caught up", systemImage: "checkmark.circle",
                  description: Text("No runs need attention or review."))
              }
            } else {
              Section("Projects") {
                ForEach(
                  store.projects.filter {
                    (finished || !$0.finished)
                      && (query.isEmpty
                        || "\($0.name) \($0.repository) \($0.prompt)"
                          .localizedCaseInsensitiveContains(query))
                  }
                ) { project in
                  NavigationLink(value: project.id) { ProjectRow(project: project) }
                }
              }
              if store.projects.isEmpty {
                ContentUnavailableView(
                  "Your next project", systemImage: "leaf",
                  description: Text("Give Herbie a brief to get started."))
              }
            }
          }
          .searchable(text: $query, prompt: "Search projects")
          .navigationTitle(store.isPreview ? "Herbie · Preview" : "Herbie")
          .refreshable { await store.perform { try await store.reload() } }
          .toolbar {
            ToolbarItem(placement: .topBarLeading) {
              Button("Settings", systemImage: "gearshape") { settings = true }
            }
            ToolbarItem(placement: .primaryAction) {
              Button("New project", systemImage: "plus") { creating = true }
            }
          }
        } detail: {
          if let selection {
            let parts = selection.split(separator: "/").map(String.init)
            ProjectView(id: parts[0], focusedAttemptID: parts.count > 1 ? parts[1] : nil).id(
              selection)
          } else {
            ContentUnavailableView(
              "Make room for good work", systemImage: "leaf",
              description: Text("Select a project or start something new."))
          }
        }
      }
    }
    .onChange(of: store.user?.id) { _, _ in selection = nil }
    .onChange(of: selection) { _, value in
      store.selectedProjectID = value?.split(separator: "/").first.map(String.init)
    }
    .task { await store.connect() }
    .task(id: "\(phase)-\(store.user?.id ?? "")") {
      guard phase == .active, store.user != nil, !store.isPreview else { return }
      while !Task.isCancelled {
        do {
          try await store.reload()
          try await Task.sleep(for: .seconds(3))
        } catch is CancellationError { return } catch {
          store.error = error.localizedDescription
          do { try await Task.sleep(for: .seconds(10)) } catch { return }
        }
      }
    }
    .sheet(isPresented: $creating) { ProjectForm(project: nil) }
    .sheet(isPresented: $settings) { SettingsView() }
    .alert(
      "Herbie",
      isPresented: Binding(get: { store.error != nil }, set: { if !$0 { store.error = nil } })
    ) {
      Button("OK") { store.error = nil }
    } message: {
      Text(store.error ?? "")
    }
  }
}
struct ProjectRow: View {
  let project: Project
  var subtitle: String?
  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      Text(project.name).font(.headline)
      Text(project.repository).font(.subheadline).foregroundStyle(.secondary)
      StatusBadge(state: project.state)
      if let subtitle { Text(subtitle).font(.caption).foregroundStyle(.secondary) }
    }.padding(.vertical, 5)
  }
}
struct StatusBadge: View {
  let state: String
  var body: some View {
    Label(
      label(state),
      systemImage: ["failed", "needs_attention"].contains(state)
        ? "exclamationmark.circle" : state == "running" ? "circle.dotted" : "circle.fill"
    )
    .font(.caption.weight(.medium))
    .foregroundStyle(
      ["failed", "needs_attention"].contains(state)
        ? .orange : state == "running" || state == "completed" ? .green : .secondary)
  }
}
func label(_ value: String) -> String { value.replacingOccurrences(of: "_", with: " ").capitalized }
struct LoginView: View {
  @Environment(Workspace.self) private var store
  @Environment(\.openURL) private var openURL
  var body: some View {
    @Bindable var store = store
    NavigationStack {
      Form {
        Section {
          Image(systemName: "leaf.fill").font(.largeTitle).foregroundStyle(.green)
          Text("Good work, always growing.").font(.largeTitle.bold())
          Text("Give Herbie a clear brief. Review the pull requests it brings back.")
            .foregroundStyle(.secondary)
        }
        Section("Your workspace") {
          TextField("https://herbie.example.com", text: $store.service).keyboardType(.URL)
            .textInputAutocapitalization(.never).autocorrectionDisabled()
            .disabled(store.approval != nil)
          Button("Continue with GitHub") { Task { await store.beginLogin() } }
            .disabled(store.busy || store.loading || store.approval != nil)
          if store.loading { ProgressView("Checking your session…") }
        }
        if let approval = store.approval {
          Section("Approve this device") {
            Text(approval.userCode ?? "Missing approval code").font(.title.monospaced())
              .textSelection(.enabled)
            Text(
              "Open GitHub sign-in and enter this code only for the login you started on this device."
            )
            Button("Open sign-in") { openURL(approval.url) }
            ProgressView("Waiting for approval…")
            Button("Cancel", role: .cancel) { store.approval = nil }
          }
          .task(id: approval.pollToken) { await store.finishLogin() }
        }
      }.navigationTitle("Welcome to Herbie")
    }
  }
}
struct SettingsView: View {
  @Environment(Workspace.self) private var store
  @Environment(\.dismiss) private var dismiss
  @Environment(\.openURL) private var openURL
  var body: some View {
    NavigationStack {
      Form {
        Section("Account") {
          Text(store.user?.login ?? "")
          Text(store.api?.baseURL.absoluteString ?? "").foregroundStyle(.secondary)
          Button("Sign out", role: .destructive) {
            Task {
              await store.logout()
              if store.user == nil { dismiss() }
            }
          }.disabled(store.busy)
        }
        Section("GitHub repositories") {
          if store.permissionsRequired {
            Text("Approve updated GitHub App permissions to publish saved work.").foregroundStyle(
              .orange)
          }
          Button("Connect repositories / update permissions") {
            Task {
              await store.perform {
                guard let api = store.api else { return }
                let result: Install = try await api.request("/api/auth/install/start", body: [:])
                openURL(result.url)
              }
            }
          }
          Button("Refresh repositories") {
            Task { await store.perform { try await store.discover() } }
          }
          ForEach(store.repositories) { Text($0.fullName) }
        }
      }
      .navigationTitle("Settings")
      .toolbar { Button("Done") { dismiss() } }
      .task { await store.perform { try await store.discover() } }
    }
  }
}
