# Agent factory

A shared company workspace for turning editable goals into a stream of reviewed improvements.

## Language

**Workspace**: A company's shared collection of goals and repository connections. Every member can manage every goal; administrators additionally manage connections and view billing settings.

**Goal**: An editable freeform outcome or checklist for one repository, with a target number of outstanding pull requests.

**Outstanding PR target**: The desired total of open pull requests and reserved creation runs for a goal. Defaults to one.

**Run**: One incremental creation or repair effort with a fixed prompt version. A run can have up to three attempts.

**Repair**: A run responding to review feedback or failing CI on an existing pull request.

**Checkpoint**: A pushed Git commit and recorded run progress that survive loss of a sandbox.

**Escalation**: A paused goal requiring a person to inspect the problem and choose whether to resume.
