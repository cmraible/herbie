# Larger-environment verification benchmark

Measured 2026-10-16 on public main revision `e6aa9c8bde4c1608ed7c379c0dabcfa7849b1e93`, without the resource-settings changes in this branch.

Daytona confirmed an image-based Ubuntu 22.04 environment with 4 CPUs, 8 GiB memory, and 10 GiB disk. Its cgroup limits also reported 4 cores and 8 GiB. The existing Herbie runtime was installed, then the repository was cloned and checked out at the fixed revision. The benchmark ran `time pnpm verify` as the non-root `compat` user. Runtime installation and cloning were excluded from the measurement. No model session or GitHub publication ran.

The cold verification command exited 1 after **144.927 seconds**. Both Docker image builds completed. The runtime image build took 37.130 seconds; the verification image build took 59.977 seconds. Portable-container smoke and image-promotion checks passed. No OOM kills were observed in the sampled cgroup counters.

The captured output reported failures in `Daytona high usage completes normally and cleans the owned process group` and `cleans up child and grandchild when silent`, including `Codex process group exit unconfirmed after shutdown deadline`. The timing summary also marked the service test stage failed, but the retained top-level output does not identify its individual failing test. These are existing-main failures, not resource-settings regression results.

The outer timing report could not write `timings.json` and `timings.txt` in the Docker-mounted artifact directory (permission denied). Its inner summary excludes the outer image-build time; use the shell's 144.927-second measurement for total elapsed time.

A warm comparison was not run after the cold checks failed. This establishes that larger sizing can complete the Docker builds, but does not establish a passing one-minute verification run or isolate the speed effect of memory from CPU and intervening source changes. Daytona confirmed deletion of the temporary environment.
