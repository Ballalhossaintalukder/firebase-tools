import * as clc from "colorette";

import * as args from "./args";
import * as backend from "./backend";
import * as build from "./build";
import * as ensureApiEnabled from "../../ensureApiEnabled";
import * as functionsConfig from "../../functionsConfig";
import * as functionsEnv from "../../functions/env";
import * as runtimes from "./runtimes";
import * as supported from "./runtimes/supported";
import * as validate from "./validate";
import * as ensure from "./ensure";
import {
  functionsOrigin,
  artifactRegistryDomain,
  runtimeconfigOrigin,
  cloudRunApiOrigin,
  eventarcOrigin,
  pubsubOrigin,
  storageOrigin,
  secretManagerOrigin,
} from "../../api";
import { Options } from "../../options";
import {
  EndpointFilter,
  endpointMatchesAnyFilter,
  getEndpointFilters,
  groupEndpointsByCodebase,
  targetCodebases,
} from "./functionsDeployHelper";
import { logLabeledBullet } from "../../utils";
import { getFunctionsConfig, prepareFunctionsUpload } from "./prepareFunctionsUpload";
import { promptForFailurePolicies, promptForMinInstances } from "./prompts";
import { needProjectId, needProjectNumber } from "../../projectUtils";
import { logger } from "../../logger";
import { ensureTriggerRegions } from "./triggerRegionHelper";
import { ensureServiceAgentRoles, ensureGenkitMonitoringRoles } from "./checkIam";
import { FirebaseError } from "../../error";
import {
  configForCodebase,
  normalizeAndValidate,
  ValidatedConfig,
} from "../../functions/projectConfig";
import { AUTH_BLOCKING_EVENTS } from "../../functions/events/v1";
import { generateServiceIdentity } from "../../gcp/serviceusage";
import { applyBackendHashToBackends } from "./cache/applyHash";
import { allEndpoints, Backend } from "./backend";
import { assertExhaustive } from "../../functional";
import { prepareDynamicExtensions } from "../extensions/prepare";
import { Context as ExtContext, Payload as ExtPayload } from "../extensions/args";
import { DeployOptions } from "..";
import * as prompt from "../../prompt";

export const EVENTARC_SOURCE_ENV = "EVENTARC_CLOUD_EVENT_SOURCE";

/**
 * Prepare functions codebases for deploy.
 */
export async function prepare(
  context: args.Context,
  options: DeployOptions,
  payload: args.Payload,
): Promise<void> {
  const projectId = needProjectId(options);
  const projectNumber = await needProjectNumber(options);

  context.config = normalizeAndValidate(options.config.src.functions);
  context.filters = getEndpointFilters(options); // Parse --only filters for functions.

  const codebases = targetCodebases(context.config, context.filters);
  if (codebases.length === 0) {
    throw new FirebaseError("No function matches given --only filters. Aborting deployment.");
  }
  for (const codebase of codebases) {
    logLabeledBullet("functions", `preparing codebase ${clc.bold(codebase)} for deployment`);
  }

  // ===Phase 0. Check that minimum APIs required for function deploys are enabled.
  const checkAPIsEnabled = await Promise.all([
    ensureApiEnabled.ensure(projectId, functionsOrigin(), "functions"),
    ensureApiEnabled.check(projectId, runtimeconfigOrigin(), "runtimeconfig", /* silent=*/ true),
    ensure.cloudBuildEnabled(projectId),
    ensureApiEnabled.ensure(projectId, artifactRegistryDomain(), "artifactregistry"),
  ]);

  // Get the Firebase Config, and set it on each function in the deployment.
  const firebaseConfig = await functionsConfig.getFirebaseConfig(options);
  context.firebaseConfig = firebaseConfig;
  let runtimeConfig: Record<string, unknown> = { firebase: firebaseConfig };
  if (checkAPIsEnabled[1]) {
    // If runtime config API is enabled, load the runtime config.
    const config = await getFunctionsConfig(projectId);
    runtimeConfig = { ...runtimeConfig, ...config };
    context.hasRuntimeConfig = Object.keys(config).length > 0;
  }

  context.codebaseDeployEvents = {};

  // ===Phase 1. Load codebases from source.
  const wantBuilds = await loadCodebases(
    context.config,
    options,
    firebaseConfig,
    runtimeConfig,
    context.filters,
  );

  // == Phase 1.5 Prepare extensions found in codebases if any
  if (Object.values(wantBuilds).some((b) => b.extensions)) {
    const extContext: ExtContext = {};
    const extPayload: ExtPayload = {};
    await prepareDynamicExtensions(extContext, options, extPayload, wantBuilds);
    context.extensions = extContext;
    payload.extensions = extPayload;
  }

  // == Phase 2. Resolve build to backend.
  const codebaseUsesEnvs: string[] = [];
  const wantBackends: Record<string, backend.Backend> = {};
  for (const [codebase, wantBuild] of Object.entries(wantBuilds)) {
    const config = configForCodebase(context.config, codebase);
    const firebaseEnvs = functionsEnv.loadFirebaseEnvs(firebaseConfig, projectId);
    const userEnvOpt: functionsEnv.UserEnvsOpts = {
      functionsSource: options.config.path(config.source),
      projectId: projectId,
      projectAlias: options.projectAlias,
    };
    const userEnvs = functionsEnv.loadUserEnvs(userEnvOpt);
    const envs = { ...userEnvs, ...firebaseEnvs };

    const { backend: wantBackend, envs: resolvedEnvs } = await build.resolveBackend({
      build: wantBuild,
      firebaseConfig,
      userEnvOpt,
      userEnvs,
      nonInteractive: options.nonInteractive,
      isEmulator: false,
    });

    let hasEnvsFromParams = false;
    wantBackend.environmentVariables = envs;
    for (const envName of Object.keys(resolvedEnvs)) {
      const isList = resolvedEnvs[envName]?.legalList;
      const envValue = resolvedEnvs[envName]?.toSDK();
      if (
        envValue &&
        !resolvedEnvs[envName].internal &&
        (!Object.prototype.hasOwnProperty.call(wantBackend.environmentVariables, envName) || isList)
      ) {
        wantBackend.environmentVariables[envName] = envValue;
        hasEnvsFromParams = true;
      }
    }

    for (const endpoint of backend.allEndpoints(wantBackend)) {
      endpoint.environmentVariables = { ...wantBackend.environmentVariables } || {};
      let resource: string;
      if (endpoint.platform === "gcfv1") {
        resource = `projects/${endpoint.project}/locations/${endpoint.region}/functions/${endpoint.id}`;
      } else if (endpoint.platform === "gcfv2") {
        // N.B. If GCF starts allowing v1's allowable characters in IDs they're
        // going to need to have a transform to create a service ID (which has a
        // more restrictive character set). We'll need to reimplement that here.
        resource = `projects/${endpoint.project}/locations/${endpoint.region}/services/${endpoint.id}`;
      } else {
        assertExhaustive(endpoint.platform);
      }
      endpoint.environmentVariables[EVENTARC_SOURCE_ENV] = resource;
      endpoint.codebase = codebase;
    }
    wantBackends[codebase] = wantBackend;
    if (functionsEnv.hasUserEnvs(userEnvOpt) || hasEnvsFromParams) {
      codebaseUsesEnvs.push(codebase);
    }

    context.codebaseDeployEvents[codebase] = {
      fn_deploy_num_successes: 0,
      fn_deploy_num_failures: 0,
      fn_deploy_num_canceled: 0,
      fn_deploy_num_skipped: 0,
    };

    if (wantBuild.params.length > 0) {
      if (wantBuild.params.every((p) => p.type !== "secret")) {
        context.codebaseDeployEvents[codebase].params = "env_only";
      } else {
        context.codebaseDeployEvents[codebase].params = "with_secrets";
      }
    } else {
      context.codebaseDeployEvents[codebase].params = "none";
    }
    context.codebaseDeployEvents[codebase].runtime = wantBuild.runtime;
  }

  // ===Phase 2.5. Before proceeding further, let's make sure that we don't have conflicting function names.
  validate.endpointsAreUnique(wantBackends);

  // ===Phase 3. Prepare source for upload.
  context.sources = {};
  for (const [codebase, wantBackend] of Object.entries(wantBackends)) {
    const config = configForCodebase(context.config, codebase);
    const sourceDirName = config.source;
    const sourceDir = options.config.path(sourceDirName);
    const source: args.Source = {};
    if (backend.someEndpoint(wantBackend, () => true)) {
      logLabeledBullet(
        "functions",
        `preparing ${clc.bold(sourceDirName)} directory for uploading...`,
      );
    }

    if (backend.someEndpoint(wantBackend, (e) => e.platform === "gcfv2")) {
      const packagedSource = await prepareFunctionsUpload(sourceDir, config);
      source.functionsSourceV2 = packagedSource?.pathToSource;
      source.functionsSourceV2Hash = packagedSource?.hash;
    }
    if (backend.someEndpoint(wantBackend, (e) => e.platform === "gcfv1")) {
      const packagedSource = await prepareFunctionsUpload(sourceDir, config, runtimeConfig);
      source.functionsSourceV1 = packagedSource?.pathToSource;
      source.functionsSourceV1Hash = packagedSource?.hash;
    }
    context.sources[codebase] = source;
  }

  // ===Phase 4. Fill in details and validate endpoints. We run the check for ALL endpoints - we think it's useful for
  // validations to fail even for endpoints that aren't being deployed so any errors are caught early.
  payload.functions = {};
  const haveBackends = groupEndpointsByCodebase(
    wantBackends,
    backend.allEndpoints(await backend.existingBackend(context)),
  );
  for (const [codebase, wantBackend] of Object.entries(wantBackends)) {
    const haveBackend = haveBackends[codebase] || backend.empty();
    payload.functions[codebase] = { wantBackend, haveBackend };
  }
  for (const [codebase, { wantBackend, haveBackend }] of Object.entries(payload.functions)) {
    inferDetailsFromExisting(wantBackend, haveBackend, codebaseUsesEnvs.includes(codebase));
    await ensureTriggerRegions(wantBackend);
    resolveCpuAndConcurrency(wantBackend);
    validate.endpointsAreValid(wantBackend);
    inferBlockingDetails(wantBackend);
  }

  // ===Phase 5. Enable APIs required by the deploying backends.
  const wantBackend = backend.merge(...Object.values(wantBackends));
  const haveBackend = backend.merge(...Object.values(haveBackends));

  await ensureAllRequiredAPIsEnabled(projectNumber, wantBackend);
  await warnIfNewGenkitFunctionIsMissingSecrets(wantBackend, haveBackend, options);

  // ===Phase 6. Ask for user prompts for things might warrant user attentions.
  // We limit the scope endpoints being deployed.
  const matchingBackend = backend.matchingBackend(wantBackend, (endpoint) => {
    return endpointMatchesAnyFilter(endpoint, context.filters);
  });
  await promptForFailurePolicies(options, matchingBackend, haveBackend);
  await promptForMinInstances(options, matchingBackend, haveBackend);

  // ===Phase 7. Finalize preparation by "fixing" all extraneous environment issues like IAM policies.
  // We limit the scope endpoints being deployed.
  await backend.checkAvailability(context, matchingBackend);
  await validate.secretsAreValid(projectId, matchingBackend);
  await ensureServiceAgentRoles(
    projectId,
    projectNumber,
    matchingBackend,
    haveBackend,
    options.dryRun,
  );
  await ensureGenkitMonitoringRoles(
    projectId,
    projectNumber,
    matchingBackend,
    haveBackend,
    options.dryRun,
  );
  await ensure.secretAccess(projectId, matchingBackend, haveBackend, options.dryRun);
  /**
   * ===Phase 8 Generates the hashes for each of the functions now that secret versions have been resolved.
   * This must be called after `await validate.secretsAreValid`.
   */
  updateEndpointTargetedStatus(wantBackends, context.filters || []);
  applyBackendHashToBackends(wantBackends, context);
}

/**
 * Adds information to the want backend types based on what we can infer from prod.
 * This can help us preserve environment variables set out of band, remember the
 * location of a trigger w/o lookup, etc.
 */
export function inferDetailsFromExisting(
  want: backend.Backend,
  have: backend.Backend,
  usedDotenv: boolean,
): void {
  for (const wantE of backend.allEndpoints(want)) {
    const haveE = have.endpoints[wantE.region]?.[wantE.id];
    if (!haveE) {
      continue;
    }

    // Copy the service id over to the new endpoint.
    wantE.runServiceId = haveE.runServiceId;

    // By default, preserve existing environment variables.
    // Only overwrite environment variables when there are user specified environment variables.
    if (!usedDotenv) {
      wantE.environmentVariables = {
        ...haveE.environmentVariables,
        ...wantE.environmentVariables,
      };
    }

    // If the instance size is set out of bounds or was previously set and is now
    // unset we still need to remember it so that the min instance price estimator
    // is accurate. If, on the other hand, we have a null value for availableMemoryMb
    // we need to keep that null (meaning "use defaults").
    if (typeof wantE.availableMemoryMb === "undefined" && haveE.availableMemoryMb) {
      wantE.availableMemoryMb = haveE.availableMemoryMb;
    }

    if (typeof wantE.cpu === "undefined" && haveE.cpu) {
      wantE.cpu = haveE.cpu;
    }

    // N.B. concurrency has different defaults based on CPU. If the customer
    // only specifies CPU and they change that specification to < 1, we should
    // turn off concurrency.
    // We'll handle this in setCpuAndConcurrency

    wantE.securityLevel = haveE.securityLevel ? haveE.securityLevel : "SECURE_ALWAYS";

    maybeCopyTriggerRegion(wantE, haveE);
  }
}

function maybeCopyTriggerRegion(wantE: backend.Endpoint, haveE: backend.Endpoint): void {
  if (!backend.isEventTriggered(wantE) || !backend.isEventTriggered(haveE)) {
    return;
  }
  if (wantE.eventTrigger.region || !haveE.eventTrigger.region) {
    return;
  }

  // Don't copy the region if anything about the trigger resource changed. It's possible
  // they changed the region
  if (
    JSON.stringify(haveE.eventTrigger.eventFilters) !==
    JSON.stringify(wantE.eventTrigger.eventFilters)
  ) {
    return;
  }
  wantE.eventTrigger.region = haveE.eventTrigger.region;
}

/**
 * Determines whether endpoints are targeted by an --only flag.
 */
export function updateEndpointTargetedStatus(
  wantBackends: Record<string, Backend>,
  endpointFilters: EndpointFilter[],
): void {
  for (const wantBackend of Object.values(wantBackends)) {
    for (const endpoint of allEndpoints(wantBackend)) {
      endpoint.targetedByOnly = endpointMatchesAnyFilter(endpoint, endpointFilters);
    }
  }
}

/** Figures out the blocking endpoint options by taking the OR of every trigger option and reassigning that value back to the endpoint. */
export function inferBlockingDetails(want: backend.Backend): void {
  const authBlockingEndpoints = backend
    .allEndpoints(want)
    .filter(
      (ep) =>
        backend.isBlockingTriggered(ep) &&
        AUTH_BLOCKING_EVENTS.includes(ep.blockingTrigger.eventType as any),
    ) as (backend.Endpoint & backend.BlockingTriggered)[];

  if (authBlockingEndpoints.length === 0) {
    return;
  }

  let accessToken = false;
  let idToken = false;
  let refreshToken = false;
  for (const blockingEp of authBlockingEndpoints) {
    accessToken ||= !!blockingEp.blockingTrigger.options?.accessToken;
    idToken ||= !!blockingEp.blockingTrigger.options?.idToken;
    refreshToken ||= !!blockingEp.blockingTrigger.options?.refreshToken;
  }
  for (const blockingEp of authBlockingEndpoints) {
    if (!blockingEp.blockingTrigger.options) {
      blockingEp.blockingTrigger.options = {};
    }
    blockingEp.blockingTrigger.options.accessToken = accessToken;
    blockingEp.blockingTrigger.options.idToken = idToken;
    blockingEp.blockingTrigger.options.refreshToken = refreshToken;
  }
}

/**
 * Assigns the CPU level to a function based on its memory if CPU is not
 * provided and sets concurrency based on the CPU level if not provided.
 * After this function, CPU will be a real number and not "gcf_gen1".
 */
export function resolveCpuAndConcurrency(want: backend.Backend): void {
  for (const e of backend.allEndpoints(want)) {
    if (e.platform === "gcfv1") {
      continue;
    }
    if (e.cpu === "gcf_gen1") {
      e.cpu = backend.memoryToGen1Cpu(e.availableMemoryMb || backend.DEFAULT_MEMORY);
    } else if (!e.cpu) {
      e.cpu = backend.memoryToGen2Cpu(e.availableMemoryMb || backend.DEFAULT_MEMORY);
    }

    if (!e.concurrency) {
      e.concurrency = e.cpu >= 1 ? backend.DEFAULT_CONCURRENCY : 1;
    }
  }
}

/**
 * Exported for use by an internal command (internaltesting:functions:discover) only.
 * @internal
 */
export async function loadCodebases(
  config: ValidatedConfig,
  options: Options,
  firebaseConfig: args.FirebaseConfig,
  runtimeConfig: Record<string, unknown>,
  filters?: EndpointFilter[],
): Promise<Record<string, build.Build>> {
  const codebases = targetCodebases(config, filters);
  const projectId = needProjectId(options);

  const wantBuilds: Record<string, build.Build> = {};
  for (const codebase of codebases) {
    const codebaseConfig = configForCodebase(config, codebase);
    const sourceDirName = codebaseConfig.source;
    if (!sourceDirName) {
      throw new FirebaseError(
        `No functions code detected at default location (./functions), and no functions source defined in firebase.json`,
      );
    }
    const sourceDir = options.config.path(sourceDirName);
    const delegateContext: runtimes.DelegateContext = {
      projectId,
      sourceDir,
      projectDir: options.config.projectDir,
      runtime: codebaseConfig.runtime,
    };
    const firebaseJsonRuntime = codebaseConfig.runtime;
    if (firebaseJsonRuntime && !supported.isRuntime(firebaseJsonRuntime as string)) {
      throw new FirebaseError(
        `Functions codebase ${codebase} has invalid runtime ` +
          `${firebaseJsonRuntime} specified in firebase.json. Valid values are: \n` +
          Object.keys(supported.RUNTIMES)
            .map((s) => `- ${s}`)
            .join("\n"),
      );
    }
    const runtimeDelegate = await runtimes.getRuntimeDelegate(delegateContext);
    logger.debug(`Validating ${runtimeDelegate.language} source`);
    supported.guardVersionSupport(runtimeDelegate.runtime);
    await runtimeDelegate.validate();
    logger.debug(`Building ${runtimeDelegate.language} source`);
    await runtimeDelegate.build();

    const firebaseEnvs = functionsEnv.loadFirebaseEnvs(firebaseConfig, projectId);
    logLabeledBullet(
      "functions",
      `Loading and analyzing source code for codebase ${codebase} to determine what to deploy`,
    );
    wantBuilds[codebase] = await runtimeDelegate.discoverBuild(runtimeConfig, {
      ...firebaseEnvs,
      // Quota project is required when using GCP's Client-based APIs
      // Some GCP client SDKs, like Vertex AI, requires appropriate quota project setup
      // in order for .init() calls to succeed.
      GOOGLE_CLOUD_QUOTA_PROJECT: projectId,
    });
    wantBuilds[codebase].runtime = codebaseConfig.runtime;
  }
  return wantBuilds;
}

// Genkit almost always requires an API key, so warn if the customer is about to deploy
// a function and doesn't have one. To avoid repetitive nagging, only warn on the first
// deploy of the function.
export async function warnIfNewGenkitFunctionIsMissingSecrets(
  have: backend.Backend,
  want: backend.Backend,
  options: DeployOptions,
) {
  if (options.force) {
    return;
  }

  const newAndMissingSecrets = backend.allEndpoints(
    backend.matchingBackend(want, (e) => {
      if (!backend.isCallableTriggered(e) || !e.callableTrigger.genkitAction) {
        return false;
      }
      if (e.secretEnvironmentVariables?.length) {
        return false;
      }
      return !backend.hasEndpoint(have)(e);
    }),
  );

  if (newAndMissingSecrets.length) {
    const message =
      `The function(s) ${newAndMissingSecrets.map((e) => e.id).join(", ")} use Genkit but do not have access to a secret. ` +
      "This may cause the function to fail if it depends on an API key. To learn more about granting a function access to " +
      "secrets, see https://firebase.google.com/docs/functions/config-env?gen=2nd#secret_parameters. Continue?";
    if (!(await prompt.confirm({ message, nonInteractive: options.nonInteractive }))) {
      throw new FirebaseError("Aborted");
    }
  }
}

// Enable required APIs. This may come implicitly from triggers (e.g. scheduled triggers
// require cloudscheduler and, in v1, require pub/sub), use of features (secrets), or explicit dependencies.
export async function ensureAllRequiredAPIsEnabled(
  projectNumber: string,
  wantBackend: backend.Backend,
): Promise<void> {
  await Promise.all(
    Object.values(wantBackend.requiredAPIs).map(({ api }) => {
      return ensureApiEnabled.ensure(projectNumber, api, "functions", /* silent=*/ false);
    }),
  );
  if (backend.someEndpoint(wantBackend, (e) => e.platform === "gcfv2")) {
    // Note: Some of these are premium APIs that require billing to be enabled.
    // We'd eventually have to add special error handling for billing APIs, but
    // enableCloudBuild is called above and has this special casing already.
    const V2_APIS = [cloudRunApiOrigin(), eventarcOrigin(), pubsubOrigin(), storageOrigin()];
    const enablements = V2_APIS.map((api) => {
      return ensureApiEnabled.ensure(projectNumber, api, "functions");
    });
    await Promise.all(enablements);
    // Need to manually kick off the p4sa activation of services
    // that we use with IAM roles assignment.
    const services = ["pubsub.googleapis.com", "eventarc.googleapis.com"];
    const generateServiceAccounts = services.map((service) => {
      return generateServiceIdentity(projectNumber, service, "functions");
    });
    await Promise.all(generateServiceAccounts);
  }

  // If function is making use of secrets, go ahead and enable Secret Manager API.
  if (
    backend.someEndpoint(
      wantBackend,
      (e) => !!(e.secretEnvironmentVariables && e.secretEnvironmentVariables.length > 0),
    )
  ) {
    await ensureApiEnabled.ensure(
      projectNumber,
      secretManagerOrigin(),
      "functions",
      /* silent=*/ false,
    );
  }
}
