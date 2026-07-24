#!/usr/bin/env bash

set -euo pipefail

usage() {
	cat <<'EOF'
Usage: create-ticket-worktree.sh --issue NUMBER --slug SLUG [options]

Create an isolated ticket branch/worktree and install dependencies. Ignored .env* files are
left operator-owned and are copied only when --copy-env is passed explicitly.

Options:
  --issue NUMBER       GitHub issue number (required)
  --slug SLUG          Lowercase branch/path slug (required)
  --base REF           Base ref (default: origin's default branch)
  --copy-env           Also copy ignored .env* files from the primary checkout and
                       verify the copies (off by default; may duplicate credentials)
  --env-source PATH    Primary checkout containing canonical local .env* files
                       (default: checkout containing this script; implies nothing
                       unless --copy-env is passed)
  --skip-install       Do not run bun install --frozen-lockfile
  -h, --help           Show this help
EOF
}

die() {
	printf 'error: %s\n' "$*" >&2
	exit 1
}

issue=""
slug=""
base_ref=""
env_source=""
copy_env=false
install_dependencies=true

while (($# > 0)); do
	case "$1" in
		--issue)
			(($# >= 2)) || die "--issue requires a value"
			issue="$2"
			shift 2
			;;
		--slug)
			(($# >= 2)) || die "--slug requires a value"
			slug="$2"
			shift 2
			;;
		--base)
			(($# >= 2)) || die "--base requires a value"
			base_ref="$2"
			shift 2
			;;
		--copy-env)
			copy_env=true
			shift
			;;
		--env-source)
			(($# >= 2)) || die "--env-source requires a value"
			env_source="$2"
			shift 2
			;;
		--skip-install)
			install_dependencies=false
			shift
			;;
		-h | --help)
			usage
			exit 0
			;;
		*) die "unknown argument: $1" ;;
	esac
done

[[ "$issue" =~ ^[1-9][0-9]*$ ]] || die "--issue must be a positive integer"
[[ "$slug" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]] ||
	die "--slug must contain lowercase letters, digits, and single hyphens"

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
script_checkout="$(git -C "$script_dir" rev-parse --show-toplevel 2>/dev/null)" ||
	die "the script must reside in a Git worktree"

if [[ -z "$env_source" ]]; then
	env_source="$script_checkout"
fi
env_source="$(cd -- "$env_source" 2>/dev/null && pwd -P)" ||
	die "environment source does not exist: $env_source"
env_source_root="$(git -C "$env_source" rev-parse --show-toplevel 2>/dev/null)" ||
	die "environment source is not a Git worktree: $env_source"
[[ "$env_source" == "$env_source_root" ]] ||
	die "--env-source must be the checkout root: $env_source_root"

script_common_dir="$(git -C "$script_checkout" rev-parse --path-format=absolute --git-common-dir)"
source_common_dir="$(git -C "$env_source" rev-parse --path-format=absolute --git-common-dir)"
[[ "$script_common_dir" == "$source_common_dir" ]] ||
	die "environment source belongs to a different Git repository"

repo_name="$(basename -- "$env_source")"
code_dir="$(dirname -- "$env_source")"
worktrees_root="$code_dir/worktrees/$repo_name"
branch="issue-$issue-$slug"
destination="$worktrees_root/$branch"

if [[ -z "$base_ref" ]]; then
	remote_head="$(git -C "$env_source" symbolic-ref --quiet refs/remotes/origin/HEAD 2>/dev/null)" ||
		die "cannot detect origin's default branch; pass --base explicitly"
	base_ref="${remote_head#refs/remotes/}"
fi

git -C "$env_source" rev-parse --verify --quiet "$base_ref^{commit}" >/dev/null ||
	die "base ref is not a commit: $base_ref"
if git -C "$env_source" show-ref --verify --quiet "refs/heads/$branch"; then
	die "ticket branch already exists: $branch"
fi
# Another session may own the ticket remotely without a local branch here. Creating a
# fresh branch from the base would later fail as non-fast-forward or rewrite that
# history, so stop and let the operator resume the existing branch instead.
if git -C "$env_source" ls-remote --exit-code --heads origin "$branch" >/dev/null 2>&1; then
	die "ticket branch already exists on origin: $branch (fetch and resume it instead)"
fi
[[ ! -e "$destination" && ! -L "$destination" ]] ||
	die "worktree destination already exists: $destination"

mkdir -p -- "$worktrees_root"
git -C "$env_source" worktree add -b "$branch" "$destination" "$base_ref"

created=true
cleanup_on_error() {
	status=$?
	if [[ "$status" -ne 0 && "$created" == true ]]; then
		printf 'Worktree setup failed; removing the incomplete worktree.\n' >&2
		git -C "$env_source" worktree remove --force "$destination" >/dev/null 2>&1 || true
		git -C "$env_source" branch -D "$branch" >/dev/null 2>&1 || true
	fi
	exit "$status"
}
trap cleanup_on_error EXIT

# Ignored .env* files stay operator-owned by default. Copying them duplicates any
# credential material they hold, so it happens only on an explicit --copy-env.
env_count=0
if [[ "$copy_env" == true ]]; then
	while IFS= read -r -d '' relative_path; do
		[[ "$relative_path" != /* && "$relative_path" != *"../"* ]] ||
			die "unsafe environment path returned by Git: $relative_path"
		source_path="$env_source/$relative_path"
		destination_path="$destination/$relative_path"
		[[ -f "$source_path" || -L "$source_path" ]] ||
			die "environment path is not a file or symlink: $relative_path"
		git -C "$destination" check-ignore --quiet -- "$relative_path" ||
			die "destination environment path is not ignored: $relative_path"
		mkdir -p -- "$(dirname -- "$destination_path")"
		cp -a -- "$source_path" "$destination_path"

		if [[ -L "$source_path" ]]; then
			[[ -L "$destination_path" ]] || die "copied symlink became a regular file: $relative_path"
			[[ "$(readlink -- "$source_path")" == "$(readlink -- "$destination_path")" ]] ||
				die "copied symlink target differs: $relative_path"
		else
			cmp --silent -- "$source_path" "$destination_path" ||
				die "copied environment file differs: $relative_path"
		fi
		((env_count += 1))
	done < <(
		git -C "$env_source" ls-files --others --ignored --exclude-standard -z -- \
			'.env*' ':(glob)**/.env*'
	)
fi

if [[ "$install_dependencies" == true ]]; then
	command -v bun >/dev/null 2>&1 || die "bun is required unless --skip-install is passed"
	bun install --frozen-lockfile --cwd "$destination"
fi

created=false
trap - EXIT
printf 'Created ticket worktree\n'
printf '  branch: %s\n' "$branch"
printf '  path: %s\n' "$destination"
printf '  base: %s\n' "$base_ref"
if [[ "$copy_env" == true ]]; then
	printf '  environment files copied: %d\n' "$env_count"
else
	printf '  environment files: left operator-owned (pass --copy-env to copy)\n'
fi
if [[ "$install_dependencies" == true ]]; then
	printf '  dependencies: installed\n'
else
	printf '  dependencies: skipped\n'
fi
