#!/usr/bin/env bash
# Called only for workflow_dispatch on main, before production environment access.
set -euo pipefail
case "${HERBIE_DEPLOY_MODE:-}" in
  automatic|manual)
    printf '%s\n' 'Deployment mode allows this manual run; configuration preflight and full Verify are still required.'
    ;;
  disabled)
    printf '%s\n' '::notice::HERBIE_DEPLOY_MODE is explicitly disabled. Verify will run; production preflight and deployment will be skipped.'
    ;;
  *)
    printf '%s\n' '::error::HERBIE_DEPLOY_MODE is missing or invalid. Set the repository variable to automatic, manual, or disabled. Verify and deployment are blocked for this manual run.' >&2
    exit 1
    ;;
esac
