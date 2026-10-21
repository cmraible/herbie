# Herbie for iOS

Native SwiftUI client for iPhone and iPad, targeting iOS 17+. Open
`Herbie.xcodeproj`, select the Herbie scheme and an iOS Simulator, then Run.
For a physical device, select your development team and a unique bundle ID in
Signing & Capabilities. No third-party Swift dependencies are required.

Enter the HTTPS origin of your existing Herbie service. Continue with GitHub,
open the browser sign-in page, and enter the device approval code shown in the
app. Return to Herbie after approval. This reuses the existing CLI device approval
protocol; no backend changes or custom callback URLs are required. Bearer sessions
are stored in device-only Keychain entries scoped to the service. Signing out
revokes the service session before removing it locally.

## Current coverage

- Search projects, hide finished work, and navigate an attention-first focus queue.
- Create recurring and single-PR projects; edit name, brief, model, reasoning,
  target WIP, and environment resources. Discover repositories/models/limits from
  the service, with custom model IDs supported. Repository and workflow stay fixed
  when editing. Drafts are retained locally per account/service/project.
- Preserve creation request IDs across retries; prepare environments and report
  preparation progress before saving.
- Pause, resume, cancel, retry runs/publication, and retry eligible failed CI repairs.
- Inspect runs, session metadata/usage, cleanup status, activity, published PRs,
  and unified diffs; open GitHub for review and merge.
- Assemble streamed transcript deltas, search activity, and export original JSONL.
- Connect repositories and approve updated installation permissions in the browser.
- Refresh while active, pull to refresh, and stop polling in the background.

This is an initial implementation, not verified end-to-end feature parity. The
native client polls every three seconds because the current WebSocket endpoint
requires browser session cookies. Transcript rendering uses selectable text
rather than the web client's full Markdown renderer, and unattributed legacy
events remain in project activity. Foreground refresh currently re-reads paginated
event history for correctness with out-of-order commits; this should move to a
bearer-authenticated stream before using very large transcripts. Focus mode opens
the selected run; return to the queue to move to the next task.

Live GitHub approval, repository installation, project mutations, environment
preparation, and transcript export through the system document picker require
validation against a configured service/device. Builds and mocked transport tests
do not establish that live integration works. App Store assets, signing,
distribution, and push notifications are not configured.

## Offline preview

In the Debug scheme's Run arguments, add `--preview` to browse a read-only sample
workspace without credentials, service requests, or agent runs. Mutation controls
are disabled. The preview switch and data are excluded from Release builds.

## Verification

```sh
swift test --package-path apps/ios
xcodebuild -project apps/ios/Herbie.xcodeproj -scheme Herbie \
  -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath /tmp/herbie-ios-build CODE_SIGNING_ALLOWED=NO build
```

Run these from the repository root on macOS with Xcode installed. The Swift
package exercises API headers and preparation/idempotency, payload validation,
focus queue rules, and transcript assembly without contacting a service.
