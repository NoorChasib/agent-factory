#!/usr/bin/env bash
#
# Agent Factory authenticated quick install (the repository is private):
#
# gh api -H "Accept: application/vnd.github.raw" /repos/NoorChasib/agent-factory/contents/install.sh?ref=main | bash
# curl -fsSL -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github.raw" "https://api.github.com/repos/NoorChasib/agent-factory/contents/install.sh?ref=main" | bash
#
# This installer uses Bash deliberately for pipefail, arrays, and safe pattern matching.

set -euo pipefail

readonly repository="NoorChasib/agent-factory"
prepared_checkout=""

info() {
	printf '==> %s\n' "$*"
}

warn() {
	printf 'Warning: %s\n' "$*" >&2
}

fail() {
	printf 'Error: %s\n' "$*" >&2
	exit 1
}

require_command() {
	local command_name=$1
	local install_hint=$2

	if ! command -v "$command_name" >/dev/null 2>&1; then
		fail "$command_name is required. $install_hint"
	fi
}

check_bun_version() {
	local bun_version
	local major
	local minor

	if ! bun_version=$(bun --version </dev/null 2>/dev/null); then
		fail "Bun is installed but 'bun --version' failed."
	fi
	if [[ ! "$bun_version" =~ ^([0-9]+)\.([0-9]+)(\.[0-9]+)?([+-].*)?$ ]]; then
		fail "Could not parse Bun version '$bun_version'; Bun 1.3 or newer is required."
	fi

	major=$((10#${BASH_REMATCH[1]}))
	minor=$((10#${BASH_REMATCH[2]}))
	if ((major < 1 || (major == 1 && minor < 3))); then
		fail "Bun $bun_version is too old; Bun 1.3 or newer is required."
	fi
	info "Bun $bun_version satisfies the minimum version."
}

check_prerequisites() {
	if [[ -z "${HOME:-}" ]]; then
		fail "HOME must be set to install Agent Factory."
	fi

	require_command "git" "Install Git before continuing."
	require_command "bun" "Install Bun 1.3 or newer before continuing."
	require_command "gh" "Install GitHub CLI before continuing."
	require_command "systemctl" "Install systemd with user-service support before continuing."
	check_bun_version

	if ! gh auth status </dev/null >/dev/null 2>&1; then
		fail "GitHub CLI is not authenticated. Run 'gh auth login' (or configure GH_TOKEN), then retry."
	fi
	info "GitHub CLI authentication is available."

	if ! systemctl --user show-environment </dev/null >/dev/null 2>&1; then
		fail "The systemd user manager is unavailable; 'systemctl --user' must work before installation."
	fi
	info "The systemd user manager is available."

	local optional_command
	for optional_command in claude codex herdr; do
		if command -v "$optional_command" >/dev/null 2>&1; then
			info "Optional runtime command found: $optional_command"
		else
			warn "$optional_command is not on PATH; installation can continue, but operation requires it."
		fi
	done
}

resolve_remote_default_branch() {
	local checkout=$1
	local remote_head

	if ! git -C "$checkout" remote get-url origin </dev/null >/dev/null 2>&1; then
		fail "The checkout has no 'origin' remote; cannot resolve the repository default branch."
	fi
	if ! git -C "$checkout" remote set-head origin --auto </dev/null >/dev/null 2>&1; then
		fail "Could not resolve origin's default branch."
	fi
	if ! remote_head=$(
		git -C "$checkout" symbolic-ref --quiet --short refs/remotes/origin/HEAD </dev/null
	); then
		fail "Origin does not advertise a default branch."
	fi
	if [[ "$remote_head" != origin/* || "$remote_head" == "origin/" ]]; then
		fail "Origin advertised an invalid default branch reference: $remote_head"
	fi

	printf '%s\n' "${remote_head#origin/}"
}

prepare_checkout() {
	local requested_checkout=$1
	local checkout_parent
	local checkout
	local default_branch
	local remote_default_ref
	local requested_ref
	local resolved_ref
	local local_head
	local remote_head

	if [[ -e "$requested_checkout" || -L "$requested_checkout" ]]; then
		if [[ ! -d "$requested_checkout" ]] ||
			! git -C "$requested_checkout" rev-parse --git-dir </dev/null >/dev/null 2>&1; then
			fail "Checkout path exists but is not a Git repository: $requested_checkout"
		fi
		if [[ -n "$(git -C "$requested_checkout" status --porcelain </dev/null)" ]]; then
			fail "Checkout has local changes; refusing to fetch or switch branches: $requested_checkout"
		fi
		info "Updating the clean checkout at $requested_checkout"
	else
		checkout_parent=$(dirname -- "$requested_checkout")
		mkdir -p -- "$checkout_parent"
		info "Cloning $repository to $requested_checkout"
		gh repo clone "$repository" "$requested_checkout" </dev/null
	fi

	checkout=$(cd -P -- "$requested_checkout" && pwd)
	info "Fetching origin without changing local work."
	git -C "$checkout" fetch --prune --tags origin </dev/null
	default_branch=$(resolve_remote_default_branch "$checkout")
	remote_default_ref="refs/remotes/origin/$default_branch"

	if git -C "$checkout" show-ref --verify --quiet "refs/heads/$default_branch" </dev/null; then
		if ! git -C "$checkout" checkout "$default_branch" </dev/null; then
			fail "Could not check out the local default branch '$default_branch'."
		fi
	else
		if ! git -C "$checkout" checkout --track -b "$default_branch" "$remote_default_ref" </dev/null; then
			fail "Could not create a local tracking branch for '$default_branch'."
		fi
	fi
	if ! git -C "$checkout" merge --ff-only "$remote_default_ref" </dev/null; then
		fail "The local default branch cannot be fast-forwarded to origin/$default_branch; no history was rewritten."
	fi

	local_head=$(git -C "$checkout" rev-parse HEAD </dev/null)
	remote_head=$(git -C "$checkout" rev-parse "$remote_default_ref" </dev/null)
	if [[ "$local_head" != "$remote_head" ]]; then
		fail "The local default branch has commits not on origin/$default_branch; refusing to discard them."
	fi

	requested_ref="${AGENT_FACTORY_REF:-$default_branch}"
	if [[ "$requested_ref" == "$default_branch" ]]; then
		resolved_ref=$remote_head
	elif resolved_ref=$(
		git -C "$checkout" rev-parse --verify "${requested_ref}^{commit}" </dev/null 2>/dev/null
	); then
		git -C "$checkout" checkout --detach "$resolved_ref" </dev/null
	elif resolved_ref=$(
		git -C "$checkout" rev-parse --verify "refs/remotes/origin/${requested_ref}^{commit}" \
			</dev/null 2>/dev/null
	); then
		git -C "$checkout" checkout --detach "$resolved_ref" </dev/null
	else
		fail "AGENT_FACTORY_REF '$requested_ref' does not resolve to a fetched commit."
	fi

	info "Building Agent Factory ref '$requested_ref' at $resolved_ref"
	prepared_checkout=$checkout
}

install_config_if_absent() {
	local source_file=$1
	local destination=$2

	if [[ -e "$destination" || -L "$destination" ]]; then
		info "Kept existing operator config (not overwritten): $destination"
		return
	fi

	install -m 0600 "$source_file" "$destination"
	info "Installed disabled example config: $destination"
}

report_doctor_failure() {
	local doctor_output=$1
	local doctor_status=$2
	local current_check=""
	local line
	local -a failed_checks=()

	while IFS= read -r line; do
		if [[ "$line" =~ \"name\"[[:space:]]*:[[:space:]]*\"([^\"]+)\" ]]; then
			current_check=${BASH_REMATCH[1]}
		elif [[ "$line" =~ \"status\"[[:space:]]*:[[:space:]]*\"fail\" ]] &&
			[[ -n "$current_check" ]]; then
			failed_checks+=("$current_check")
			current_check=""
		fi
	done <<<"$doctor_output"

	if ((${#failed_checks[@]} > 0)); then
		printf 'Warning: non-live doctor failed checks:' >&2
		printf ' %s' "${failed_checks[@]}" >&2
		printf '\n' >&2
	else
		warn "Non-live doctor exited with status $doctor_status; see its output above."
	fi
	warn "Doctor failures do not abort installation; provider tools, App credentials, and runtime setup may still be unconfigured."
}

check_prerequisites
if [[ "${AGENT_FACTORY_INSTALL_CHECK_ONLY:-0}" == "1" ]]; then
	info "Prerequisite check complete; AGENT_FACTORY_INSTALL_CHECK_ONLY=1 requested no installation."
	exit 0
fi

requested_checkout="${AGENT_FACTORY_CHECKOUT:-$HOME/.local/src/agent-factory}"
prepare_checkout "$requested_checkout"
checkout=$prepared_checkout

cd -- "$checkout"
info "Installing frozen dependencies."
bun install --frozen-lockfile </dev/null
if [[ "${AGENT_FACTORY_SKIP_VALIDATE:-0}" == "1" ]]; then
	warn "Skipping the source-checkout validation because AGENT_FACTORY_SKIP_VALIDATE=1 (not recommended)."
else
	info "Validating the source checkout."
	bun run validate </dev/null
fi

config_root="${XDG_CONFIG_HOME:-$HOME/.config}/agent-factory"
profiles_root="$config_root/profiles"
install -d -m 0700 "$config_root" "$profiles_root"
install_config_if_absent \
	"$checkout/config/examples/multi-project/config.yaml" \
	"$config_root/config.yaml"

shopt -s nullglob
profile_sources=("$checkout"/config/examples/multi-project/profiles/*.yaml)
if ((${#profile_sources[@]} == 0)); then
	fail "The checkout contains no shipped multi-project profile examples."
fi
for profile_source in "${profile_sources[@]}"; do
	install_config_if_absent "$profile_source" "$profiles_root/${profile_source##*/}"
done
shopt -u nullglob

release_commit=$(git -C "$checkout" rev-parse HEAD </dev/null)
export AGENT_FACTORY_SOURCE_REPOSITORY="$checkout"
info "Bootstrapping immutable observation-mode release $release_commit"
bun run bootstrap -- "$release_commit" </dev/null

data_root="${XDG_DATA_HOME:-$HOME/.local/share}"
release_cli="$data_root/agent-factory/releases/current/bin/agent-factory"
cli_directory="$HOME/.local/bin"
cli_link="$cli_directory/agent-factory"
cli_link_ready=0

if [[ ! -x "$release_cli" ]]; then
	fail "Bootstrap completed without an executable release CLI at $release_cli"
fi
install -d -m 0755 "$cli_directory"
if [[ ! -e "$cli_link" && ! -L "$cli_link" ]]; then
	ln -s "$release_cli" "$cli_link"
	info "Installed CLI symlink: $cli_link -> $release_cli"
	cli_link_ready=1
elif [[ -L "$cli_link" ]]; then
	existing_target=$(readlink -- "$cli_link")
	if [[ "$existing_target" == /* ]]; then
		resolved_existing_target=$(readlink -m -- "$existing_target")
	else
		resolved_existing_target=$(readlink -m -- "$cli_directory/$existing_target")
	fi
	if [[ "$resolved_existing_target" == */agent-factory/releases/*/bin/agent-factory ]]; then
		ln -sfn "$release_cli" "$cli_link"
		info "Refreshed managed CLI symlink: $cli_link -> $release_cli"
		cli_link_ready=1
	else
		warn "Leaving foreign CLI symlink unchanged: $cli_link -> $existing_target"
	fi
else
	warn "Leaving foreign CLI path unchanged: $cli_link"
fi

if ((cli_link_ready == 1)); then
	info "Checking the installed CLI version."
	"$cli_link" version </dev/null
	info "Running non-live local diagnostics (failures are reported but do not abort installation)."
	doctor_status=0
	doctor_output=$("$cli_link" doctor </dev/null 2>&1) || doctor_status=$?
	printf '%s\n' "$doctor_output"
	if ((doctor_status != 0)); then
		report_doctor_failure "$doctor_output" "$doctor_status"
	fi
else
	warn "Skipped CLI version and doctor checks because $cli_link is operator-owned."
fi

systemd_user_root="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
systemd_source="$checkout/systemd/agent-factory.service"
systemd_destination="$systemd_user_root/agent-factory.service"
install -d -m 0755 "$systemd_user_root"
if [[ ! -e "$systemd_destination" && ! -L "$systemd_destination" ]]; then
	install -m 0644 "$systemd_source" "$systemd_destination"
	info "Installed user unit: $systemd_destination"
elif [[ -f "$systemd_destination" ]] && cmp -s "$systemd_source" "$systemd_destination"; then
	info "Kept byte-identical user unit: $systemd_destination"
else
	warn "Existing user unit differs; leaving it unchanged: $systemd_destination"
fi

info "Reloading the systemd user manager without enabling or launching the service."
systemctl --user daemon-reload </dev/null

activation_tool="systemctl"
activation_action="enable"
printf '\nAgent Factory installation finished in observation mode.\n'
printf 'Next steps (operator actions; see %s/docs/installation.md):\n' "$checkout"
printf '  1. Edit %s and profiles under %s; replace the ntfy endpoint and topic.\n' \
	"$config_root/config.yaml" "$profiles_root"
printf '  2. Create and install the GitHub App per %s/docs/github-app.md.\n' "$checkout"
printf '  3. Place the App PEM at %s/credentials/github-app.pem with mode 0600.\n' "$config_root"
printf '  4. Create the non-secret environment file at %s/environment.\n' "$config_root"
printf '  5. When configuration and credentials are ready, run:\n'
printf '       %s --user %s --now agent-factory\n' "$activation_tool" "$activation_action"
printf '  6. Keep rollout promotion explicit and attended after reviewing observations.\n'
printf '\nEverything performed so far is observation-mode inert: no service was enabled or launched, no profile was enabled, and no rollout was promoted.\n'
