import { spawnSync } from "node:child_process";

const repository = process.argv[2] ?? "jason-allen-oneal/Odinn";
const ownerUserId = Number(process.argv[3] ?? "8335428");

function gh(endpoint: any, method: any = "GET", body: any = undefined) {
  const args = ["api", `repos/${repository}${endpoint}`, "--method", method];
  if (body !== undefined) args.push("--input", "-");
  const result = spawnSync("gh", args, {
    encoding: "utf8",
    input: body === undefined ? undefined : JSON.stringify(body),
    stdio: ["pipe", "pipe", "pipe"]
  });
  if (result.status !== 0) {
    throw new Error(`gh api ${endpoint} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

const requiredChecks = [
  "Quality and unit tests",
  "Platform test (ubuntu-latest)",
  "Platform test (macos-latest)",
  "Platform test (windows-latest)",
  "Integration and inference protocol",
  "Package smoke (ubuntu-latest)",
  "Package smoke (macos-latest)",
  "Package smoke (windows-latest)",
  "Verify package (ubuntu-latest)",
  "Verify package (macos-latest)",
  "Verify package (windows-latest)",
  "CodeQL",
  "Dependency review",
  "Dependency and lockfile audit",
  "Secret scan",
  "actionlint",
  "Conventional title"
];

console.log(`Configuring ${repository}`);

gh("/actions/permissions/workflow", "PUT", {
  default_workflow_permissions: "read",
  can_approve_pull_request_reviews: false
});

gh("/vulnerability-alerts", "PUT");
try {
  gh("/private-vulnerability-reporting", "PUT");
} catch (error: any) {
  console.warn(`Private vulnerability reporting could not be enabled: ${error.message}`);
}
try {
  gh("/automated-security-fixes", "PUT");
} catch (error: any) {
  console.warn(`Dependabot security updates could not be enabled: ${error.message}`);
}

gh("/branches/main/protection", "PUT", {
  required_status_checks: {
    strict: true,
    contexts: requiredChecks
  },
  enforce_admins: false,
  required_pull_request_reviews: {
    dismissal_restrictions: {},
    dismiss_stale_reviews: true,
    require_code_owner_reviews: true,
    required_approving_review_count: 1,
    require_last_push_approval: false
  },
  restrictions: null,
  required_linear_history: true,
  allow_force_pushes: false,
  allow_deletions: false,
  block_creations: false,
  required_conversation_resolution: true,
  lock_branch: false,
  allow_fork_syncing: true
});

try {
  gh("/environments/release", "PUT", {
    wait_timer: 0,
    reviewers: [{ type: "User", id: ownerUserId }],
    deployment_branch_policy: {
      protected_branches: true,
      custom_branch_policies: false
    }
  });
} catch (error: any) {
  console.warn(`Release environment reviewer policy could not be applied: ${error.message}`);
  gh("/environments/release", "PUT", {
    wait_timer: 0,
    deployment_branch_policy: {
      protected_branches: true,
      custom_branch_policies: false
    }
  });
}

console.log("Repository policy configured.");
console.log(`Required checks: ${requiredChecks.join(", ")}`);
