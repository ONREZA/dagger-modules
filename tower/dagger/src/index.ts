import { func, object } from "@dagger.io/dagger";

const RELEASE_SCHEMA = "tower.release.v1";
const WORKFLOW_SCHEMA = "tower.workflow.v1";
const CONTRACT_PREFIX = `${RELEASE_SCHEMA}: `;
const ARTIFACT_KINDS = new Set(["oci_bundle", "image", "manifest", "metadata", "other"]);
const WORKFLOW_KINDS = new Set(["ci", "release", "smoke", "verify", "promote", "maintenance"]);
const WORKFLOW_STEP_TYPES = new Set(["dagger_call", "flux_wait", "smoke", "approval", "manual", "webhook"]);
const USER_ROLES = new Set(["viewer", "operator", "release_manager", "admin"]);
const MAX_I32 = 2_147_483_647;

type JsonObject = Record<string, unknown>;

type ReleaseArtifact = {
  kind: string;
  name: string;
  ref: string;
  digest?: string;
  metadata_json?: JsonObject;
};

type ReleaseContract = {
  schema: typeof RELEASE_SCHEMA;
  source_commit?: string;
  source_ref?: string;
  promoted_from_release_id?: string;
  git_tag?: string;
  metadata_json?: JsonObject;
  artifacts: ReleaseArtifact[];
};

type WorkflowApproval = {
  key?: string;
  title?: string;
  description?: string;
  required_role?: string;
  payload_json?: JsonObject;
  expires_in_seconds?: number;
};

type WorkflowStep = {
  name: string;
  step_type: string;
  dagger_module?: string;
  dagger_command?: string;
  params?: JsonObject[];
  inputs?: JsonObject;
  resource_requirements?: JsonObject[];
  depends_on?: number[];
  timeout_seconds?: number;
  continue_on_failure?: boolean;
  approval?: WorkflowApproval;
};

type WorkflowProfile = {
  name: string;
  display_name?: string;
  kind: string;
  enabled?: boolean;
  dagger_module?: string;
  default_params?: JsonObject[];
  input_schema?: JsonObject;
  default_inputs?: JsonObject;
  resource_requirements?: JsonObject[];
  runner_profile?: string;
  timeout_seconds?: number;
  concurrency_policy?: string;
  allowed_environments?: string[];
  steps: WorkflowStep[];
};

type WorkflowSpec = {
  schema: typeof WORKFLOW_SCHEMA;
  workflows: WorkflowProfile[];
};

function optional(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function parseJson(value: string, field: string): unknown {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`${field} must be valid JSON: ${String(error)}`);
  }
}

function parseObjectJson(value: string, field: string): JsonObject {
  const trimmed = value.trim();
  if (trimmed === "") {
    return {};
  }
  const parsed = parseJson(trimmed, field);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${field} must be a JSON object`);
  }
  return parsed as JsonObject;
}

function parseArrayJson(value: string, field: string): unknown[] {
  const parsed = parseJson(value, field);
  if (!Array.isArray(parsed)) {
    throw new Error(`${field} must be a JSON array`);
  }
  return parsed;
}

function parseObjectArrayJson(value: string, field: string): JsonObject[] {
  return parseArrayJson(value, field).map((entry, index) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`${field}[${index}] must be a JSON object`);
    }
    return entry as JsonObject;
  });
}

function parseStringArrayJson(value: string, field: string): string[] {
  return parseArrayJson(value, field).map((entry, index) => {
    if (typeof entry !== "string" || entry.trim() === "") {
      throw new Error(`${field}[${index}] must be a non-empty string`);
    }
    return entry.trim();
  });
}

function parseStepsJson(value: string): WorkflowStep[] {
  return parseArrayJson(value, "stepsJson").map((entry, index) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`stepsJson[${index}] must be a JSON object`);
    }
    return normalizeWorkflowStep(entry as Partial<WorkflowStep>, `stepsJson[${index}]`);
  });
}

function parseWorkflowsJson(value: string): WorkflowProfile[] {
  return parseArrayJson(value, "workflowsJson").map((entry, index) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`workflowsJson[${index}] must be a JSON object`);
    }
    return normalizeWorkflow(entry as Partial<WorkflowProfile>, `workflowsJson[${index}]`);
  });
}

function positiveInt(value: number, field: string): number | undefined {
  if (value === 0) {
    return undefined;
  }
  if (!Number.isInteger(value) || value < 0 || value > MAX_I32) {
    throw new Error(`${field} must be a non-negative 32-bit integer`);
  }
  return value;
}

function requiredEnum(value: string, field: string, allowed: Set<string>): string {
  const normalized = value.trim();
  if (!allowed.has(normalized)) {
    throw new Error(`${field} ${JSON.stringify(value)} is unsupported: expected ${[...allowed].join(", ")}`);
  }
  return normalized;
}

function rejectDependsOn(dependsOn: number[] | undefined, field: string): void {
  if (dependsOn && dependsOn.length > 0) {
    throw new Error(`${field}.depends_on is not supported by Tower's current sequential workflow executor`);
  }
}

function digestFromRef(ref: string): string | undefined {
  const marker = "@sha256:";
  const index = ref.lastIndexOf(marker);
  if (index < 0) {
    return undefined;
  }
  return ref.slice(index + 1);
}

function normalizeArtifact(
  kind: string,
  name: string,
  ref: string,
  digest = "",
  metadataJson = "{}",
): ReleaseArtifact {
  const normalizedKind = kind.trim();
  if (!ARTIFACT_KINDS.has(normalizedKind)) {
    throw new Error(
      `artifact kind ${JSON.stringify(kind)} is unsupported: expected ${[...ARTIFACT_KINDS].join(", ")}`,
    );
  }

  const normalizedName = name.trim();
  if (normalizedName === "") {
    throw new Error("artifact name must not be empty");
  }

  const normalizedRef = ref.trim();
  if (normalizedRef === "") {
    throw new Error("artifact ref must not be empty");
  }

  const metadata = parseObjectJson(metadataJson, "metadataJson");
  const normalizedDigest = optional(digest) ?? digestFromRef(normalizedRef);

  return {
    kind: normalizedKind,
    name: normalizedName,
    ref: normalizedRef,
    ...(normalizedDigest ? { digest: normalizedDigest } : {}),
    ...(Object.keys(metadata).length > 0 ? { metadata_json: metadata } : {}),
  };
}

function parseArtifactJson(value: string, field: string): ReleaseArtifact {
  const parsed = parseJson(value, field);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${field} must be a JSON object`);
  }
  const artifact = parsed as Partial<ReleaseArtifact>;
  return normalizeArtifact(
    String(artifact.kind ?? ""),
    String(artifact.name ?? ""),
    String(artifact.ref ?? ""),
    String(artifact.digest ?? ""),
    JSON.stringify(artifact.metadata_json ?? {}),
  );
}

function parseArtifactsJson(value: string, allowEmpty = false): ReleaseArtifact[] {
  const parsed = parseJson(value, "artifactsJson");
  if (!Array.isArray(parsed)) {
    throw new Error("artifactsJson must be a JSON array");
  }
  const artifacts = parsed.map((entry, index) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`artifactsJson[${index}] must be a JSON object`);
    }
    const artifact = entry as Partial<ReleaseArtifact>;
    return normalizeArtifact(
      String(artifact.kind ?? ""),
      String(artifact.name ?? ""),
      String(artifact.ref ?? ""),
      String(artifact.digest ?? ""),
      JSON.stringify(artifact.metadata_json ?? {}),
    );
  });
  if (!allowEmpty && artifacts.length === 0) {
    throw new Error("artifactsJson must contain at least one artifact");
  }
  return artifacts;
}

function buildReleaseContract(
  artifactsJson: string,
  sourceCommit = "",
  sourceRef = "",
  promotedFromReleaseId = "",
  gitTag = "",
  metadataJson = "{}",
): ReleaseContract {
  const metadata = parseObjectJson(metadataJson, "metadataJson");
  const sourceCommitValue = optional(sourceCommit);
  const sourceRefValue = optional(sourceRef);
  const promotedFromReleaseIdValue = optional(promotedFromReleaseId);
  const gitTagValue = optional(gitTag);
  return {
    schema: RELEASE_SCHEMA,
    ...(sourceCommitValue ? { source_commit: sourceCommitValue } : {}),
    ...(sourceRefValue ? { source_ref: sourceRefValue } : {}),
    ...(promotedFromReleaseIdValue ? { promoted_from_release_id: promotedFromReleaseIdValue } : {}),
    ...(gitTagValue ? { git_tag: gitTagValue } : {}),
    ...(Object.keys(metadata).length > 0 ? { metadata_json: metadata } : {}),
    artifacts: parseArtifactsJson(artifactsJson),
  };
}

function normalizeWorkflowApproval(
  approval: Partial<WorkflowApproval>,
  field: string,
): WorkflowApproval {
  const key = optional(String(approval.key ?? ""));
  const title = optional(String(approval.title ?? ""));
  const description = optional(String(approval.description ?? ""));
  const requiredRole = optional(String(approval.required_role ?? ""));
  const expiresInSeconds =
    typeof approval.expires_in_seconds === "number"
      ? positiveInt(approval.expires_in_seconds, `${field}.expires_in_seconds`)
      : undefined;
  if (requiredRole) {
    requiredEnum(requiredRole, `${field}.required_role`, USER_ROLES);
  }
  const payload = approval.payload_json;
  if (payload !== undefined && (payload === null || typeof payload !== "object" || Array.isArray(payload))) {
    throw new Error(`${field}.payload_json must be a JSON object`);
  }

  return {
    ...(key ? { key } : {}),
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    ...(requiredRole ? { required_role: requiredRole } : {}),
    ...(payload && Object.keys(payload).length > 0 ? { payload_json: payload as JsonObject } : {}),
    ...(expiresInSeconds ? { expires_in_seconds: expiresInSeconds } : {}),
  };
}

function normalizeWorkflowStep(step: Partial<WorkflowStep>, field: string): WorkflowStep {
  const name = optional(String(step.name ?? ""));
  if (!name) {
    throw new Error(`${field}.name must not be empty`);
  }
  const stepType = requiredEnum(String(step.step_type ?? ""), `${field}.step_type`, WORKFLOW_STEP_TYPES);
  const daggerModule = optional(String(step.dagger_module ?? ""));
  const daggerCommand = optional(String(step.dagger_command ?? ""));
  const timeoutSeconds =
    typeof step.timeout_seconds === "number" ? positiveInt(step.timeout_seconds, `${field}.timeout_seconds`) : undefined;
  const isDaggerBacked = stepType === "dagger_call" || stepType === "smoke";
  if (isDaggerBacked && !daggerCommand) {
    throw new Error(`${field}.dagger_command must not be empty for ${stepType} steps`);
  }
  if (!isDaggerBacked && daggerCommand) {
    throw new Error(`${field}.dagger_command is only valid for dagger_call and smoke steps`);
  }
  rejectDependsOn(step.depends_on, field);
  if ((stepType === "approval" || stepType === "manual") && step.approval !== undefined) {
    return {
      name,
      step_type: stepType,
      ...(step.inputs ? { inputs: step.inputs } : {}),
      ...(step.resource_requirements && step.resource_requirements.length > 0
        ? { resource_requirements: step.resource_requirements }
        : {}),
      ...(timeoutSeconds ? { timeout_seconds: timeoutSeconds } : {}),
      ...(step.continue_on_failure ? { continue_on_failure: true } : {}),
      approval: normalizeWorkflowApproval(step.approval, `${field}.approval`),
    };
  }
  if (step.approval !== undefined) {
    throw new Error(`${field}.approval is only valid for approval and manual steps`);
  }

  return {
    name,
    step_type: stepType,
    ...(daggerModule ? { dagger_module: daggerModule } : {}),
    ...(daggerCommand ? { dagger_command: daggerCommand } : {}),
    ...(step.params && step.params.length > 0 ? { params: step.params } : {}),
    ...(step.inputs && Object.keys(step.inputs).length > 0 ? { inputs: step.inputs } : {}),
    ...(step.resource_requirements && step.resource_requirements.length > 0
      ? { resource_requirements: step.resource_requirements }
      : {}),
    ...(timeoutSeconds ? { timeout_seconds: timeoutSeconds } : {}),
    ...(step.continue_on_failure ? { continue_on_failure: true } : {}),
  };
}

function normalizeWorkflow(workflow: Partial<WorkflowProfile>, field: string): WorkflowProfile {
  const name = optional(String(workflow.name ?? ""));
  if (!name) {
    throw new Error(`${field}.name must not be empty`);
  }
  const kind = requiredEnum(String(workflow.kind ?? ""), `${field}.kind`, WORKFLOW_KINDS);
  const steps = (workflow.steps ?? []).map((step, index) => normalizeWorkflowStep(step, `${field}.steps[${index}]`));
  if (steps.length === 0) {
    throw new Error(`${field}.steps must contain at least one step`);
  }
  const displayName = optional(String(workflow.display_name ?? ""));
  const daggerModule = optional(String(workflow.dagger_module ?? ""));
  const runnerProfile = optional(String(workflow.runner_profile ?? ""));
  const concurrencyPolicy = optional(String(workflow.concurrency_policy ?? ""));
  const timeoutSeconds =
    typeof workflow.timeout_seconds === "number"
      ? positiveInt(workflow.timeout_seconds, `${field}.timeout_seconds`)
      : undefined;

  return {
    name,
    kind,
    steps,
    ...(displayName ? { display_name: displayName } : {}),
    ...(workflow.enabled === false ? { enabled: false } : {}),
    ...(daggerModule ? { dagger_module: daggerModule } : {}),
    ...(workflow.default_params && workflow.default_params.length > 0 ? { default_params: workflow.default_params } : {}),
    ...(workflow.input_schema && Object.keys(workflow.input_schema).length > 0 ? { input_schema: workflow.input_schema } : {}),
    ...(workflow.default_inputs && Object.keys(workflow.default_inputs).length > 0
      ? { default_inputs: workflow.default_inputs }
      : {}),
    ...(workflow.resource_requirements && workflow.resource_requirements.length > 0
      ? { resource_requirements: workflow.resource_requirements }
      : {}),
    ...(runnerProfile ? { runner_profile: runnerProfile } : {}),
    ...(timeoutSeconds ? { timeout_seconds: timeoutSeconds } : {}),
    ...(concurrencyPolicy ? { concurrency_policy: concurrencyPolicy } : {}),
    ...(workflow.allowed_environments && workflow.allowed_environments.length > 0
      ? { allowed_environments: workflow.allowed_environments }
      : {}),
  };
}

function buildWorkflowSpec(workflowsJson: string): WorkflowSpec {
  const workflows = parseWorkflowsJson(workflowsJson);
  if (workflows.length === 0) {
    throw new Error("workflowsJson must contain at least one workflow");
  }
  return {
    schema: WORKFLOW_SCHEMA,
    workflows,
  };
}

/**
 * Generic helpers for Dagger pipelines orchestrated by Tower.
 *
 * The module intentionally does not build or deploy anything. It only provides
 * stable primitives for Dagger modules to emit Tower's machine-readable release
 * and workflow contracts.
 */
@object()
export class Tower {
  /**
   * Return an empty JSON array for builder append helpers.
   */
  @func()
  emptyArray(): string {
    return "[]";
  }

  /**
   * Build one release artifact JSON object.
   */
  @func()
  artifact(kind: string, name: string, ref: string, digest = "", metadataJson = "{}"): string {
    return JSON.stringify(normalizeArtifact(kind, name, ref, digest, metadataJson));
  }

  /**
   * Build an OCI release bundle artifact JSON object.
   */
  @func()
  ociBundle(name: string, ref: string, digest = "", metadataJson = "{}"): string {
    return this.artifact("oci_bundle", name, ref, digest, metadataJson);
  }

  /**
   * Build an image artifact JSON object.
   */
  @func()
  image(name: string, ref: string, digest = "", metadataJson = "{}"): string {
    return this.artifact("image", name, ref, digest, metadataJson);
  }

  /**
   * Append an artifact object to an artifacts JSON array.
   */
  @func()
  appendArtifact(artifactsJson: string, artifactJson: string): string {
    const artifacts = parseArtifactsJson(artifactsJson, true);
    artifacts.push(parseArtifactJson(artifactJson, "artifactJson"));
    return JSON.stringify(artifacts);
  }

  /**
   * Build a Tower release contract JSON object.
   */
  @func()
  release(
    artifactsJson: string,
    sourceCommit = "",
    sourceRef = "",
    promotedFromReleaseId = "",
    gitTag = "",
    metadataJson = "{}",
  ): string {
    return JSON.stringify(
      buildReleaseContract(artifactsJson, sourceCommit, sourceRef, promotedFromReleaseId, gitTag, metadataJson),
    );
  }

  /**
   * Build the stdout line parsed by Tower after a release Dagger step.
   */
  @func()
  emitRelease(
    artifactsJson: string,
    sourceCommit = "",
    sourceRef = "",
    promotedFromReleaseId = "",
    gitTag = "",
    metadataJson = "{}",
  ): string {
    return `${CONTRACT_PREFIX}${this.release(
      artifactsJson,
      sourceCommit,
      sourceRef,
      promotedFromReleaseId,
      gitTag,
      metadataJson,
    )}`;
  }

  /**
   * Build approval metadata for an approval/manual workflow step.
   */
  @func()
  approval(
    title = "",
    description = "",
    requiredRole = "",
    key = "",
    payloadJson = "{}",
    expiresInSeconds = 0,
  ): string {
    return JSON.stringify(
      normalizeWorkflowApproval(
        {
          title: optional(title),
          description: optional(description),
          required_role: optional(requiredRole),
          key: optional(key),
          payload_json: parseObjectJson(payloadJson, "payloadJson"),
          expires_in_seconds: positiveInt(expiresInSeconds, "expiresInSeconds"),
        },
        "approval",
      ),
    );
  }

  /**
   * Build a generic workflow step JSON object.
   */
  @func()
  workflowStep(
    name: string,
    stepType: string,
    daggerCommand = "",
    daggerModule = "",
    paramsJson = "[]",
    inputsJson = "{}",
    resourceRequirementsJson = "[]",
    timeoutSeconds = 0,
    continueOnFailure = false,
    approvalJson = "",
  ): string {
    const approval = approvalJson.trim() ? parseObjectJson(approvalJson, "approvalJson") : undefined;
    return JSON.stringify(
      normalizeWorkflowStep(
        {
          name,
          step_type: stepType,
          dagger_command: optional(daggerCommand),
          dagger_module: optional(daggerModule),
          params: parseObjectArrayJson(paramsJson, "paramsJson"),
          inputs: parseObjectJson(inputsJson, "inputsJson"),
          resource_requirements: parseObjectArrayJson(resourceRequirementsJson, "resourceRequirementsJson"),
          timeout_seconds: positiveInt(timeoutSeconds, "timeoutSeconds"),
          continue_on_failure: continueOnFailure,
          approval: approval as WorkflowApproval | undefined,
        },
        "workflowStep",
      ),
    );
  }

  /**
   * Build a Dagger-backed workflow step JSON object.
   */
  @func()
  daggerStep(
    name: string,
    daggerCommand: string,
    daggerModule = "",
    paramsJson = "[]",
    inputsJson = "{}",
    resourceRequirementsJson = "[]",
    timeoutSeconds = 0,
    continueOnFailure = false,
  ): string {
    return this.workflowStep(
      name,
      "dagger_call",
      daggerCommand,
      daggerModule,
      paramsJson,
      inputsJson,
      resourceRequirementsJson,
      timeoutSeconds,
      continueOnFailure,
    );
  }

  /**
   * Build a smoke workflow step JSON object.
   */
  @func()
  smokeStep(
    name: string,
    daggerCommand: string,
    daggerModule = "",
    paramsJson = "[]",
    inputsJson = "{}",
    resourceRequirementsJson = "[]",
    timeoutSeconds = 0,
    continueOnFailure = false,
  ): string {
    return this.workflowStep(
      name,
      "smoke",
      daggerCommand,
      daggerModule,
      paramsJson,
      inputsJson,
      resourceRequirementsJson,
      timeoutSeconds,
      continueOnFailure,
    );
  }

  /**
   * Build an approval workflow step JSON object.
   */
  @func()
  approvalStep(
    name: string,
    title = "",
    description = "",
    requiredRole = "",
    key = "",
    payloadJson = "{}",
    expiresInSeconds = 0,
    timeoutSeconds = 0,
  ): string {
    return this.workflowStep(
      name,
      "approval",
      "",
      "",
      "[]",
      "{}",
      "[]",
      timeoutSeconds,
      false,
      this.approval(title, description, requiredRole, key, payloadJson, expiresInSeconds),
    );
  }

  /**
   * Build a Flux wait workflow step JSON object.
   */
  @func()
  fluxWaitStep(name: string, inputsJson = "{}", timeoutSeconds = 0, continueOnFailure = false): string {
    return this.workflowStep(
      name,
      "flux_wait",
      "",
      "",
      "[]",
      inputsJson,
      "[]",
      timeoutSeconds,
      continueOnFailure,
    );
  }

  /**
   * Append a workflow step object to a steps JSON array.
   */
  @func()
  appendWorkflowStep(stepsJson: string, stepJson: string): string {
    const steps = parseStepsJson(stepsJson);
    const parsed = parseJson(stepJson, "stepJson");
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("stepJson must be a JSON object");
    }
    steps.push(normalizeWorkflowStep(parsed as Partial<WorkflowStep>, "stepJson"));
    return JSON.stringify(steps);
  }

  /**
   * Build a Tower workflow profile JSON object.
   */
  @func()
  workflow(
    name: string,
    kind: string,
    stepsJson: string,
    displayName = "",
    enabled = true,
    daggerModule = "",
    defaultParamsJson = "[]",
    inputSchemaJson = "{}",
    defaultInputsJson = "{}",
    resourceRequirementsJson = "[]",
    runnerProfile = "",
    timeoutSeconds = 0,
    concurrencyPolicy = "",
    allowedEnvironmentsJson = "[]",
  ): string {
    return JSON.stringify(
      normalizeWorkflow(
        {
          name,
          kind,
          display_name: optional(displayName),
          enabled,
          dagger_module: optional(daggerModule),
          default_params: parseObjectArrayJson(defaultParamsJson, "defaultParamsJson"),
          input_schema: parseObjectJson(inputSchemaJson, "inputSchemaJson"),
          default_inputs: parseObjectJson(defaultInputsJson, "defaultInputsJson"),
          resource_requirements: parseObjectArrayJson(resourceRequirementsJson, "resourceRequirementsJson"),
          runner_profile: optional(runnerProfile),
          timeout_seconds: positiveInt(timeoutSeconds, "timeoutSeconds"),
          concurrency_policy: optional(concurrencyPolicy),
          allowed_environments: parseStringArrayJson(allowedEnvironmentsJson, "allowedEnvironmentsJson"),
          steps: parseStepsJson(stepsJson),
        },
        "workflow",
      ),
    );
  }

  /**
   * Append a workflow profile object to a workflows JSON array.
   */
  @func()
  appendWorkflow(workflowsJson: string, workflowJson: string): string {
    const workflows = parseWorkflowsJson(workflowsJson);
    const parsed = parseJson(workflowJson, "workflowJson");
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("workflowJson must be a JSON object");
    }
    workflows.push(normalizeWorkflow(parsed as Partial<WorkflowProfile>, "workflowJson"));
    return JSON.stringify(workflows);
  }

  /**
   * Build the complete Tower workflow spec JSON file.
   */
  @func()
  workflowSpec(workflowsJson: string): string {
    return JSON.stringify(buildWorkflowSpec(workflowsJson));
  }

  /**
   * Build the complete Tower workflow spec JSON file with stable indentation.
   */
  @func()
  prettyWorkflowSpec(workflowsJson: string): string {
    return JSON.stringify(buildWorkflowSpec(workflowsJson), null, 2);
  }
}
