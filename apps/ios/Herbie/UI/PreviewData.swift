#if DEBUG
  import Foundation

  // Offline, read-only simulator data. Never authenticates or starts runs.
  enum PreviewData {
    static let projectID = "11111111-1111-4111-8111-111111111111"
    static let runID = "22222222-2222-4222-8222-222222222222"
    static var projects: [Project] {
      let pr = PullRequest(
        number: 42, url: "https://github.com/example/herbie/pull/42", state: "open",
        branch: "herbie/reliable-retries", title: "Make retries reliable",
        body: "Preserves saved work when a connection drops.", draft: false, checksPassed: true,
        additions: 28, deletions: 9, changedFiles: 3)
      let run = Attempt(
        id: runID, number: 2, state: "awaiting_review", createdAt: "2026-10-20T18:30:00Z",
        pullRequest: pr)
      let base = Project(
        id: projectID, ownerId: "preview", name: "A more reliable Herbie",
        repository: "example/herbie",
        prompt:
          "Make interrupted work easy to recover. Keep the changes small and add focused regression tests.",
        model: "gpt-6-luna", reasoningEffort: "low", workflow: "loop", targetWip: 1,
        state: "awaiting_review", attemptCount: 2, attempts: [run],
        createdAt: "2026-10-20T18:00:00Z", updatedAt: "2026-10-20T19:00:00Z", pullRequests: [pr],
        cleanupStatus: "complete")
      var running = base
      running.id = "33333333-3333-4333-8333-333333333333"
      running.name = "Thoughtful error messages"
      running.state = "running"
      running.attempts = []
      running.pullRequests = []
      var attention = running
      attention.id = "44444444-4444-4444-8444-444444444444"
      attention.name = "Faster project startup"
      attention.state = "failed"
      attention.error = "Run interrupted. Retry to start a new run."
      return [base, running, attention]
    }
    static var events: [ProjectEvent] {
      [
        ProjectEvent(
          id: 1, projectId: projectID, type: "agent",
          message:
            #"{"method":"item/completed","params":{"threadId":"preview","turnId":"1","item":{"id":"message","type":"agentMessage","text":"Added recovery for interrupted requests. All regression tests pass."}}}"#,
          createdAt: "2026-10-20T19:00:00Z", attemptId: runID)
      ]
    }
  }
#endif
