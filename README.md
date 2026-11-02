# Herbie

Herbie turns coding tasks into GitHub pull requests and keeps them moving through
CI and human review. Give it a repository and a brief, then follow its progress
from the web app, CLI, or native iPhone and iPad client. Work continues after you
close the app.

## Two ways to work

- **Single PR:** Hand Herbie a bug, feature, or other task. It opens one pull request,
  responds to review feedback, and repairs failing CI checks. The project finishes
  when the PR is merged or closed.
- **Recurring project:** Give Herbie an ongoing objective and choose how much work
  it should keep in progress. It creates new pull requests as earlier work merges,
  continuing until you pause or cancel it, a run fails, or a PR closes without merging.

## Stay in control

Track projects, inspect changes, watch agent activity, and download transcripts.
Herbie publishes draft pull requests and marks them ready for review when checks
pass. Review and merge the work in GitHub.

You can pause, resume, or cancel projects, retry eligible failures, and update the
brief or model for future runs. For recurring projects, you can also adjust the
amount of work in progress.

## Get started

Sign in to your Herbie service with GitHub, connect a repository, and create a
project. Choose **Single PR** for a specific task or **Recurring project** for an
ongoing goal, then describe what you want accomplished.

To run your own Herbie service, follow the [setup guide](docs/setup.md).

## Documentation

- [Development and testing](docs/development.md)
- [Service operations and recovery](docs/service.md)
- [Deployment](docs/portable-deployment.md)
- [iOS client setup and status](docs/ios.md)
- [Earlier ChatGPT demo](docs/demo.md)
