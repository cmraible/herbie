import SwiftUI

struct ProjectForm: View {
  let project: Project?
  @Environment(Workspace.self) private var store
  @Environment(\.dismiss) private var dismiss
  @State private var draft = ProjectDraft()
  @State private var models: [String] = []
  @State private var efforts: [String] = []
  @State private var limits: Limits?
  @State private var saving = false
  @State private var phase = "Saving project…"
  @State private var error: String?
  @State private var loaded = false
  @State private var savedBody: Data?
  private var storageKey: String {
    "projectDraft." + (store.api?.baseURL.absoluteString ?? "") + "." + (store.user?.id ?? "") + "."
      + (project?.id ?? "new")
  }
  var body: some View {
    NavigationStack {
      Form {
        Section("Project") {
          TextField("Name (automatic if empty)", text: $draft.name)
          if let project {
            LabeledContent("Repository", value: project.repository)
          } else {
            Picker("Repository", selection: $draft.repository) {
              Text("Choose repository").tag("")
              ForEach(store.repositories) { Text($0.fullName).tag($0.fullName) }
            }
            Button("Refresh repositories") {
              Task { await store.perform { try await store.discover() } }
            }
            if store.permissionsRequired || store.repositories.isEmpty {
              Text("Connect repositories or update permissions in Settings.").foregroundStyle(
                .secondary)
            }
            Picker("Workflow", selection: $draft.workflow) {
              Text("Recurring project").tag("loop")
              Text("Single PR").tag("single_pr")
            }
          }
          if draft.workflow == "loop" {
            Stepper(
              "Target WIP: \(draft.targetWip)", value: $draft.targetWip, in: 1...2_147_483_647)
          }
          Text(
            draft.workflow == "single_pr"
              ? "Produces one PR and supports it through checks and review."
              : "Maintains the target number of open PRs and active runs."
          ).font(.footnote).foregroundStyle(.secondary)
        }
        Section("Brief") {
          TextEditor(text: $draft.prompt).frame(minHeight: 180).accessibilityLabel("Project brief")
          Text("\(draft.prompt.count) / 8000 characters").font(.caption).foregroundStyle(.secondary)
        }
        Section("Agent") {
          TextField("Model ID", text: $draft.model).textInputAutocapitalization(.never)
            .autocorrectionDisabled()
          if !models.isEmpty {
            Picker("Suggested models", selection: $draft.model) {
              ForEach(Array(Set(models + [draft.model])).sorted(), id: \.self) { Text($0).tag($0) }
            }
          }
          Picker("Reasoning", selection: $draft.reasoningEffort) {
            ForEach(Array(Set(efforts + [draft.reasoningEffort])).sorted(), id: \.self) {
              Text(label($0)).tag($0)
            }
          }
        }
        Section("Environment") {
          Toggle(
            "Custom resources",
            isOn: Binding(
              get: { draft.resources != nil },
              set: {
                draft.resources =
                  $0
                  ? Resources(
                    cpu: min(4, limits?.cpu ?? 4), memory: min(8, limits?.memory ?? 8),
                    disk: min(10, limits?.disk ?? 10)) : nil
              }))
          if draft.resources != nil {
            resource("CPU cores", key: \.cpu, maximum: limits?.cpu)
            resource("Memory (GiB)", key: \.memory, maximum: limits?.memory)
            resource("Disk (GiB)", key: \.disk, maximum: limits?.disk)
            if limits == nil {
              Text("Load resource limits before saving custom resources.").foregroundStyle(.orange)
              Button("Retry loading limits") { Task { await loadLimits() } }
            }
          }
          Text(
            "Changes apply to future runs. Larger environments cost more and share your organization’s quota."
          ).font(.footnote).foregroundStyle(.secondary)
        }
        if let error { Section { Text(error).foregroundStyle(.red).textSelection(.enabled) } }
        if saving { Section { ProgressView(phase) } }
      }
      .disabled(saving)
      .navigationTitle(project == nil ? "New project" : "Edit project")
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel") { dismiss() }.disabled(saving)
        }
        ToolbarItem(placement: .confirmationAction) {
          Button(project == nil ? "Create" : "Save") { Task { await save() } }
            .disabled(
              store.isPreview || saving || !draft.valid
                || (project != nil
                  && draft.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                || !resourcesValid)
        }
      }
      .interactiveDismissDisabled(saving)
      .task {
        if !loaded {
          if let data = UserDefaults.standard.data(forKey: storageKey),
            let saved = try? JSONDecoder().decode(ProjectDraft.self, from: data)
          {
            draft = saved
          } else if let project {
            draft = ProjectDraft(project)
          }
          savedBody = try? JSONEncoder.sorted.encode(draft.body(editing: project != nil))
          loaded = true
        }
        guard let api = store.api else { return }
        do {
          try await store.discover()
          models = try await api.request("/api/models")
        } catch { self.error = error.localizedDescription }
        await loadLimits()
      }
      .task(id: draft.model) {
        guard let api = store.api else { return }
        do {
          var c = URLComponents()
          c.queryItems = [URLQueryItem(name: "model", value: draft.model)]
          efforts = try await api.request("/api/reasoning-efforts?" + (c.percentEncodedQuery ?? ""))
          if !efforts.contains(draft.reasoningEffort), let first = efforts.first {
            draft.reasoningEffort = first
          }
        } catch is CancellationError {} catch { self.error = error.localizedDescription }
      }
      .onChange(of: draft.workflow) { _, value in if value == "single_pr" { draft.targetWip = 1 } }
      .onChange(of: draft) { _, _ in
        guard loaded else { return }
        let body = try? JSONEncoder.sorted.encode(draft.body(editing: project != nil))
        if body != savedBody {
          draft.requestId = UUID().uuidString
          savedBody = body
        }
        if let data = try? JSONEncoder().encode(draft) {
          UserDefaults.standard.set(data, forKey: storageKey)
        }
      }
    }
  }
  private var resourcesValid: Bool {
    guard let r = draft.resources else { return true }
    guard let limits else { return false }
    return r.cpu <= (limits.cpu ?? Int.max) && r.memory <= (limits.memory ?? Int.max)
      && r.disk <= (limits.disk ?? Int.max)
  }
  private func resource(_ title: String, key: WritableKeyPath<Resources, Int>, maximum: Int?)
    -> some View
  {
    Stepper(
      "\(title): \(draft.resources?[keyPath: key] ?? 1)",
      value: Binding(
        get: { draft.resources?[keyPath: key] ?? 1 },
        set: { draft.resources?[keyPath: key] = $0 }
      ), in: 1...max(1, maximum ?? 65536))
  }
  private func loadLimits() async {
    do { limits = try await store.api?.request("/api/environment-limits") } catch {
      self.error = error.localizedDescription
    }
  }
  private func save() async {
    guard let api = store.api else { return }
    saving = true
    error = nil
    defer { saving = false }
    do {
      let result = try await api.save(draft, projectID: project?.id) { message in
        await MainActor.run { phase = message }
      }
      store.upsert(result)
      UserDefaults.standard.removeObject(forKey: storageKey)
      dismiss()
    } catch { self.error = error.localizedDescription }
  }
}

extension JSONEncoder {
  fileprivate static var sorted: JSONEncoder {
    let encoder = JSONEncoder()
    encoder.outputFormatting = .sortedKeys
    return encoder
  }
}
