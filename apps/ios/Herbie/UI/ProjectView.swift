import SwiftUI
import UniformTypeIdentifiers

struct ProjectView: View {
  let id: String
  var focusedAttemptID: String?
  @Environment(Workspace.self) private var store
  @Environment(\.scenePhase) private var phase
  @State private var editing = false
  @State private var cancelling = false
  private var events: [ProjectEvent] { store.projectEvents[id] ?? [] }
  @State private var eventsError: String?
  @State private var eventsLoaded = false
  var body: some View {
    if let project = store.projects.first(where: { $0.id == id }) {
      Group {
        if let focusedAttemptID,
          let attempt = project.attempts?.first(where: { $0.id == focusedAttemptID })
        {
          RunView(project: project, attempt: attempt, events: events)
        } else {
          List {
            Section {
              StatusBadge(state: project.state)
              Text(project.prompt).textSelection(.enabled)
              LabeledContent("Repository", value: project.repository)
              LabeledContent(
                "Workflow",
                value: project.workflow == "single_pr"
                  ? "Single PR" : "Recurring · WIP \(project.targetWip)")
              LabeledContent("Agent", value: "\(project.model) · \(project.reasoningEffort)")
              LabeledContent("Cleanup", value: label(project.cleanupStatus))
              if let resources = project.resources {
                Text(
                  "\(resources.cpu) cores · \(resources.memory) GiB RAM · \(resources.disk) GiB disk"
                ).font(.caption)
              }
              if let stop = project.stopRequested {
                Text("\(label(stop)) requested. The current run will finish before stopping.")
                  .foregroundStyle(.orange)
              }
            }
            if let error = project.error {
              Section("Needs attention") {
                Text(error).textSelection(.enabled)
                if project.needsAttention {
                  Button(project.publicationBlocked ? "Retry publication" : "Retry run") {
                    Task {
                      await store.action(
                        project, project.publicationBlocked ? "retry-publication" : "retry")
                    }
                  }.disabled(store.busy || store.isPreview)
                }
              }
            }
            if !project.prs.isEmpty {
              Section("Pull requests") {
                ForEach(project.prs) { pr in
                  NavigationLink {
                    PullRequestView(projectID: id, pr: pr)
                  } label: {
                    PullRequestRow(pr: pr)
                  }
                }
              }
            }
            Section("Runs · \(project.attemptCount)") {
              ForEach((project.attempts ?? []).sorted { $0.number > $1.number }) { attempt in
                NavigationLink {
                  RunView(project: project, attempt: attempt, events: events)
                } label: {
                  VStack(alignment: .leading, spacing: 5) {
                    Text("Run \(attempt.number)").font(.headline)
                    StatusBadge(state: attempt.state)
                    Text(attempt.createdAt).font(.caption).foregroundStyle(.secondary)
                  }
                }
                if let repair = attempt.ciRepair, repair.canRetry, repair.state == "failed",
                  project.stopRequested == nil,
                  ["queued", "running", "awaiting_review"].contains(project.state),
                  attempt.pullRequest?.state == "open"
                {
                  Button("Retry repair for run \(attempt.number)") {
                    Task { await store.action(project, "retry-repair", repairID: repair.id) }
                  }.disabled(store.busy || store.isPreview)
                }
              }
            }
            Section("Project activity") {
              if !eventsLoaded { ProgressView("Loading activity…") }
              if let eventsError {
                Text(eventsError).foregroundStyle(.orange)
                Button("Retry") { Task { await loadEvents() } }
              }
              ForEach(events.filter { $0.type != "agent" && $0.attemptId == nil }.reversed()) {
                event in
                VStack(alignment: .leading) {
                  Text(label(event.type)).font(.caption.bold())
                  Text(event.message).textSelection(.enabled)
                  Text(event.createdAt).font(.caption).foregroundStyle(.secondary)
                }
              }
              NavigationLink("All agent activity") { TranscriptView(events: events, projectID: id) }
            }
          }
        }
      }
      .navigationTitle(project.name)
      .refreshable {
        await loadEvents()
        await store.perform { try await store.reload() }
      }
      .toolbar {
        Menu {
          if project.state != "cancelled" {
            Button("Edit project", systemImage: "pencil") { editing = true }
          }
          if !project.finished && !["paused", "needs_attention", "failed"].contains(project.state) {
            Button("Pause", systemImage: "pause") { Task { await store.action(project, "pause") } }
              .disabled(project.stopRequested != nil)
          }
          if project.state == "paused" {
            Button("Resume", systemImage: "play") { Task { await store.action(project, "resume") } }
          }
          if !project.finished && project.state != "failed" {
            Button("Cancel project", systemImage: "xmark", role: .destructive) { cancelling = true }
          }
        } label: {
          Label("Project actions", systemImage: "ellipsis.circle")
        }.disabled(store.busy || store.isPreview)
      }
      .confirmationDialog(
        "Cancel this project?", isPresented: $cancelling, titleVisibility: .visible
      ) {
        Button("Cancel project", role: .destructive) {
          Task { await store.action(project, "cancel") }
        }
      }
      .sheet(isPresented: $editing) { ProjectForm(project: project) }
      .task { await loadEvents() }
    } else {
      ContentUnavailableView("Project unavailable", systemImage: "folder")
    }
  }
  private func loadEvents() async {
    #if DEBUG
      if store.isPreview {
        store.projectEvents[id] = PreviewData.events
        eventsLoaded = true
        return
      }
    #endif
    guard let api = store.api else { return }
    do {
      store.projectEvents[id] = try await api.events(projectID: id)
      eventsLoaded = true
      eventsError = nil
    } catch is CancellationError {} catch { eventsError = error.localizedDescription }
  }
}
struct RunView: View {
  let project: Project
  let attempt: Attempt
  let events: [ProjectEvent]
  @Environment(Workspace.self) private var store
  var body: some View {
    let project = store.projects.first(where: { $0.id == self.project.id }) ?? self.project
    let attempt = project.attempts?.first(where: { $0.id == self.attempt.id }) ?? self.attempt
    let events = store.projectEvents[project.id] ?? self.events
    List {
      Section {
        StatusBadge(state: attempt.state)
        Text(attempt.createdAt)
        if project.needsAttention {
          if let error = project.error { Text(error).textSelection(.enabled) }
          Button(project.publicationBlocked ? "Retry publication" : "Retry run") {
            Task {
              await store.action(
                project, project.publicationBlocked ? "retry-publication" : "retry")
            }
          }.disabled(store.busy || store.isPreview)
        }
        if let repair = attempt.ciRepair, repair.state == "failed", repair.canRetry,
          project.stopRequested == nil,
          ["queued", "running", "awaiting_review"].contains(project.state),
          attempt.pullRequest?.state == "open"
        {
          Button("Retry repair") {
            Task { await store.action(project, "retry-repair", repairID: repair.id) }
          }.disabled(store.busy || store.isPreview)
        }
      }
      if let pr = attempt.pullRequest {
        Section {
          NavigationLink {
            PullRequestView(projectID: project.id, pr: pr)
          } label: {
            PullRequestRow(pr: pr)
          }
        }
      }
      Section("Agent sessions") {
        ForEach(attempt.sessions ?? []) { session in
          DisclosureGroup("\(label(session.kind)) · \(label(session.state))") {
            LabeledContent("Model", value: session.model)
            LabeledContent("Reasoning", value: session.reasoningEffort)
            LabeledContent("Started", value: session.startedAt)
            if let finished = session.finishedAt { LabeledContent("Finished", value: finished) }
            LabeledContent("Cleanup", value: session.cleanup)
            if let environment = session.environment {
              LabeledContent(environment.provider, value: environment.id)
            }
            if let thread = session.threadId {
              Text(thread).font(.caption.monospaced()).textSelection(.enabled)
            }
            if let usage = session.usage, let data = try? JSONEncoder().encode(usage) {
              Text(String(decoding: data, as: UTF8.self)).font(.caption.monospaced()).textSelection(
                .enabled)
            }
          }
        }
      }
      Section {
        NavigationLink("Agent transcript") {
          TranscriptView(events: events, projectID: project.id, attemptID: attempt.id)
        }
      }
      Section("Activity") {
        ForEach(events.filter { $0.attemptId == attempt.id && $0.type != "agent" }) { event in
          VStack(alignment: .leading) {
            Text(label(event.type)).font(.caption.bold())
            Text(event.message).textSelection(.enabled)
          }
        }
      }
    }.navigationTitle("Run \(attempt.number)")
  }
}
struct PullRequestRow: View {
  let pr: PullRequest
  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      Text("#\(pr.number) \(pr.title ?? pr.branch)").font(.headline)
      Text(
        pr.state == "open" ? pr.ready ? "Ready for review" : "Waiting for checks" : label(pr.state)
      ).font(.caption).foregroundStyle(.secondary)
      if let additions = pr.additions, let deletions = pr.deletions {
        Text("+\(additions) −\(deletions) · \(pr.changedFiles ?? 0) files").font(
          .caption.monospaced())
      }
    }
  }
}
struct PullRequestView: View {
  let projectID: String
  let pr: PullRequest
  @Environment(Workspace.self) private var store
  @State private var diff: String?
  @State private var error: String?
  var body: some View {
    List {
      Section {
        PullRequestRow(pr: pr)
        if let url = URL(string: pr.url), url.scheme == "https" {
          Link("Review on GitHub", destination: url)
        }
        if let body = pr.body { Text(.init(body)).textSelection(.enabled) }
      }
      Section("Changes") {
        if let error {
          Text(error).foregroundStyle(.orange)
          Button("Retry") { Task { await load() } }
        } else if let diff {
          ScrollView(.horizontal) {
            LazyVStack(alignment: .leading, spacing: 0) {
              ForEach(Array(diff.components(separatedBy: "\n").enumerated()), id: \.offset) {
                _, line in
                Text(line.isEmpty ? " " : line).font(.system(.caption, design: .monospaced))
                  .foregroundStyle(
                    line.hasPrefix("+") ? .green : line.hasPrefix("-") ? .red : .primary
                  ).textSelection(.enabled)
              }
            }
          }
        } else {
          ProgressView("Loading diff…")
        }
      }
    }.navigationTitle("PR #\(pr.number)").task { await load() }
  }
  private func load() async {
    error = nil
    #if DEBUG
      if store.isPreview {
        diff =
          "diff --git a/example.ts b/example.ts\n--- a/example.ts\n+++ b/example.ts\n@@ -1 +1 @@\n-return a - b;\n+return a + b;"
        return
      }
    #endif
    do {
      let result: Diff? = try await store.api?.request(
        "/api/projects/\(projectID)/pull-requests/\(pr.number)/diff")
      diff = result?.diff
    } catch { self.error = error.localizedDescription }
  }
}
struct TranscriptDocument: FileDocument {
  static var readableContentTypes: [UTType] { [.plainText] }
  var text: String
  init(text: String) { self.text = text }
  init(configuration: ReadConfiguration) throws {
    text = String(decoding: configuration.file.regularFileContents ?? Data(), as: UTF8.self)
  }
  func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper {
    FileWrapper(regularFileWithContents: Data(text.utf8))
  }
}
struct TranscriptView: View {
  let events: [ProjectEvent]
  var projectID: String
  var attemptID: String?
  @Environment(Workspace.self) private var store
  @State private var query = ""
  @State private var exporting = false
  @State private var exportError: String?
  private var currentEvents: [ProjectEvent] {
    (store.projectEvents[projectID] ?? events).filter {
      attemptID == nil || $0.attemptId == attemptID
    }
  }
  var body: some View {
    ScrollViewReader { proxy in
      List {
        ForEach(
          Activity.assemble(currentEvents).filter {
            query.isEmpty || ($0.type + $0.text).localizedCaseInsensitiveContains(query)
          }
        ) { item in
          DisclosureGroup(label(item.type)) {
            Text(item.text).font(.system(.body, design: .monospaced)).textSelection(.enabled)
          }
        }
        Text("Latest update").font(.caption).foregroundStyle(.secondary).id("latest")
      }
      .searchable(text: $query, prompt: "Search transcript")
      .toolbar {
        Button("Latest", systemImage: "arrow.down.to.line") { proxy.scrollTo("latest") }
        Button("Export JSONL", systemImage: "square.and.arrow.up") { exporting = true }
      }
    }
    .navigationTitle("Agent transcript")
    .fileExporter(
      isPresented: $exporting,
      document: TranscriptDocument(
        text: currentEvents.filter { $0.type == "agent" }.map(\.message).joined(separator: "\n")
          + "\n"),
      contentType: .plainText, defaultFilename: "agent-transcript.jsonl"
    ) { result in
      if case .failure(let error) = result { exportError = error.localizedDescription }
    }
    .alert(
      "Export failed",
      isPresented: Binding(get: { exportError != nil }, set: { if !$0 { exportError = nil } })
    ) {
      Button("OK") { exportError = nil }
    } message: {
      Text(exportError ?? "")
    }
  }
}
