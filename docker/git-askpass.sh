#!/bin/bash
# git-askpass.sh — reads credentials from /run/secrets/git_token (tmpfs)
# instead of from argv or env vars visible to child processes.
#
# Git invokes this script with a prompt like:
#   "Username for 'https://github.com':"
#   "Password for 'https://x-access-token@github.com':"
#
# We answer:
#   username → "x-access-token" (GitHub PAT convention)
#   password → contents of /run/secrets/git_token
#
# This keeps the token out of:
#   - .git/config (remote URL has no embedded token)
#   - ps/argv (never passed on command line)
#   - docker inspect (never in container Env)

case "$1" in
    Username*)
        echo "x-access-token"
        ;;
    Password*)
        if [ -r /run/secrets/git_token ]; then
            cat /run/secrets/git_token
        else
            echo ""
        fi
        ;;
    *)
        # Unknown prompt — decline
        echo ""
        ;;
esac
