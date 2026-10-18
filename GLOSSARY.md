# Herbie

Language for describing work in Herbie.

## Language

**Project**:
An ongoing body of work guided by instructions and carried out through runs.
_Avoid_: Goal

**Run**:
One contribution to a project, carried through implementation and review by one or more agent sessions.
_Avoid_: Attempt

**Instructions**:
What you want the agent to accomplish.
_Avoid_: Goal prompt

**Agent Session**:
One execution of the agent within a run, such as initial implementation, repairing checks, or responding to review feedback.

**Agent**:
The AI that works on your project.

**Environment**:
The temporary workspace where an agent session happens.
_Avoid_: Sandbox

**Patches**:
The code edits produced by a run.
_Avoid_: Changes, artifacts

**Pull request**:
Patches submitted for your review on GitHub.

**Checks**:
Automated tests and validations of the patches.
_Avoid_: CI

**Activity**:
Updates about your project's progress.
_Avoid_: Events, audit history
