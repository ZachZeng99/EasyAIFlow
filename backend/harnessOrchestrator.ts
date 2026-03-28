import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  HarnessBootstrapResult,
  HarnessRunOptions,
  HarnessRunResult,
  HarnessRole,
  HarnessSessionState,
  SessionRecord,
} from '../src/data/types.js';

type HarnessManifest = {
  version: 1;
  sourceSessionId: string;
  sourceSessionTitle: string;
  workspace: string;
  artifactDir: string;
  plannerSessionId: string;
  generatorSessionId: string;
  evaluatorSessionId: string;
  status: 'idle' | 'running' | 'completed' | 'failed';
  currentStage: string;
  currentSprint: number;
  completedSprints: number;
  lastDecision: string;
  settings: Required<Pick<HarnessRunOptions, 'maxSprints' | 'maxContractRounds' | 'maxImplementationRounds'>> & {
    model?: string;
    effort?: 'low' | 'medium' | 'high' | 'max';
  };
  timeline: Array<{
    at: string;
    role: HarnessRole | 'system';
    stage: string;
    sprint: number;
    round: number;
    decision: string;
    details?: string;
  }>;
};

type RoleTurnExecutor = (input: {
  sessionId: string;
  prompt: string;
  model?: string;
  effort?: 'low' | 'medium' | 'high' | 'max';
}) => Promise<{ content: string }>;

type HarnessOrchestratorInput = {
  entrySessionId: string;
  options?: HarnessRunOptions;
  bootstrapHarness: (sessionId: string) => Promise<HarnessBootstrapResult>;
  findSession: (sessionId: string) => Promise<SessionRecord | null>;
  runRoleTurn: RoleTurnExecutor;
  onProgress?: (state: HarnessSessionState) => Promise<void> | void;
};

const defaultOptions = {
  maxSprints: 3,
  maxContractRounds: 2,
  maxImplementationRounds: 2,
} as const;

const buildArtifactPaths = (artifactDir: string) => ({
  spec: path.join(artifactDir, 'product-spec.md'),
  contract: path.join(artifactDir, 'sprint-contract.md'),
  evaluation: path.join(artifactDir, 'evaluation-report.md'),
  handoff: path.join(artifactDir, 'handoff.md'),
  manifest: path.join(artifactDir, 'manifest.json'),
});

const readTaggedValue = (content: string, key: string) => {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = content.match(new RegExp(`^${escaped}:\\s*(.+)$`, 'im'));
  return match?.[1]?.trim() ?? '';
};

const readDecision = (content: string, key: string, allowed: string[]) => {
  const value = readTaggedValue(content, key).toUpperCase();
  return allowed.includes(value) ? value : '';
};

const readScore = (content: string, key: string) => {
  const raw = readTaggedValue(content, key);
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : 0;
};

const appendTimeline = (
  manifest: HarnessManifest,
  entry: HarnessManifest['timeline'][number],
) => {
  manifest.timeline.push(entry);
  manifest.currentStage = entry.stage;
  manifest.currentSprint = entry.sprint;
  manifest.lastDecision = entry.decision;
};

const countTotalTurns = (
  settings: HarnessManifest['settings'],
) => 1 + settings.maxSprints * ((settings.maxContractRounds * 2) + (settings.maxImplementationRounds * 2));

const toHarnessSessionState = (
  manifest: HarnessManifest,
  currentOwner?: HarnessRole,
  summary?: string,
  currentRound?: number,
): HarnessSessionState => {
  const latestEntry = manifest.timeline[manifest.timeline.length - 1];

  return {
  plannerSessionId: manifest.plannerSessionId,
  generatorSessionId: manifest.generatorSessionId,
  evaluatorSessionId: manifest.evaluatorSessionId,
  artifactDir: manifest.artifactDir,
  status:
    manifest.status === 'idle'
      ? 'ready'
      : manifest.status,
  currentOwner,
  currentStage: manifest.currentStage,
  currentSprint: manifest.currentSprint,
  currentRound: currentRound ?? latestEntry?.round ?? 0,
  completedSprints: manifest.completedSprints,
  maxSprints: manifest.settings.maxSprints,
  completedTurns: manifest.timeline.filter((entry) => entry.role !== 'system').length,
  totalTurns: countTotalTurns(manifest.settings),
  lastDecision: manifest.lastDecision,
  summary,
  updatedAt: Date.now(),
  };
};

const persistManifest = async (manifestPath: string, manifest: HarnessManifest) => {
  await mkdir(path.dirname(manifestPath), { recursive: true });
  await writeFile(
    manifestPath,
    `${JSON.stringify(
      {
        ...manifest,
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
};

const loadManifest = async (
  artifactDir: string,
  rootSession: SessionRecord,
  bootstrap: HarnessBootstrapResult,
  options: Required<Pick<HarnessRunOptions, 'maxSprints' | 'maxContractRounds' | 'maxImplementationRounds'>> & {
    model?: string;
    effort?: 'low' | 'medium' | 'high' | 'max';
  },
) => {
  const manifestPath = buildArtifactPaths(artifactDir).manifest;
  let parsed: Partial<HarnessManifest> = {};

  try {
    parsed = JSON.parse(await readFile(manifestPath, 'utf8')) as Partial<HarnessManifest>;
  } catch {
    parsed = {};
  }

  const manifest: HarnessManifest = {
    version: 1,
    sourceSessionId: rootSession.id,
    sourceSessionTitle: rootSession.title,
    workspace: rootSession.workspace,
    artifactDir,
    plannerSessionId: bootstrap.plannerSessionId,
    generatorSessionId: bootstrap.generatorSessionId,
    evaluatorSessionId: bootstrap.evaluatorSessionId,
    status: 'idle',
    currentStage: parsed.currentStage ?? 'idle',
    currentSprint: parsed.currentSprint ?? 0,
    completedSprints: parsed.completedSprints ?? 0,
    lastDecision: parsed.lastDecision ?? 'NOT_STARTED',
    settings: options,
    timeline: parsed.timeline ?? [],
  };

  await persistManifest(manifestPath, manifest);
  return manifest;
};

const buildPlannerPrompt = (rootSession: SessionRecord, artifactDir: string) => {
  const files = buildArtifactPaths(artifactDir);
  return [
    `Use the root session "${rootSession.title}" as the product request anchor.`,
    `Refresh the shared product spec in ${files.spec}.`,
    'Expand the request into a concrete multi-sprint product spec with an ordered backlog.',
    'Stay high-level on implementation details unless a technical choice is necessary to preserve feasibility.',
    `Refresh ${files.handoff} with the next most valuable sprint candidate and major risks.`,
    'Do not ask the user questions. Make reasonable assumptions and record them.',
    'Reply using exactly these tags on separate lines:',
    'PLANNER_STATUS: READY',
    'PLANNER_NEXT_SPRINT: <one-sentence next sprint goal>',
    'PLANNER_SUMMARY: <one short paragraph>',
  ].join('\n');
};

const buildGeneratorContractPrompt = (artifactDir: string, sprint: number) => {
  const files = buildArtifactPaths(artifactDir);
  return [
    `Plan sprint ${sprint}.`,
    `Read ${files.spec}, ${files.handoff}, and ${files.manifest}.`,
    `Update ${files.contract} with a single sprint contract: objective, done criteria, verification plan, and explicit out-of-scope items.`,
    'Choose the single highest-value next sprint. If the product is already at a strong stopping point, mark the run as done.',
    'Do not ask the user questions. Make reasonable assumptions and record them in the contract.',
    'Reply using exactly these tags on separate lines:',
    'SPRINT_STATUS: READY or DONE',
    'SPRINT_GOAL: <one sentence>',
    'SPRINT_SUMMARY: <one short paragraph>',
  ].join('\n');
};

const buildEvaluatorContractPrompt = (artifactDir: string, sprint: number) => {
  const files = buildArtifactPaths(artifactDir);
  return [
    `Review the proposed sprint ${sprint} contract.`,
    `Read ${files.spec}, ${files.contract}, ${files.handoff}, and ${files.manifest}.`,
    'Approve only if the sprint contract is specific, testable, and aligned with the product spec.',
    `Write any required revisions into ${files.evaluation} and ${files.handoff}.`,
    'Be skeptical and concrete.',
    'Reply using exactly these tags on separate lines:',
    'CONTRACT_DECISION: APPROVED or REVISE',
    'CONTRACT_REASON: <one short paragraph>',
  ].join('\n');
};

const buildGeneratorImplementationPrompt = (artifactDir: string, sprint: number, attempt: number) => {
  const files = buildArtifactPaths(artifactDir);
  return [
    `Implement sprint ${sprint}, attempt ${attempt}.`,
    `Read ${files.contract}, ${files.evaluation}, ${files.handoff}, and ${files.manifest}.`,
    'Implement only the approved sprint contract. Prefer verifiable progress over speculative scope.',
    'Run the checks that are necessary to validate the sprint.',
    `Update ${files.handoff} with changed areas, checks run, remaining risks, and the next evaluator focus.`,
    'Do not ask the user questions.',
    'Reply using exactly these tags on separate lines:',
    'IMPLEMENTATION_STATUS: COMPLETE',
    'IMPLEMENTATION_SUMMARY: <one short paragraph>',
    'IMPLEMENTATION_CHECKS: <one line>',
  ].join('\n');
};

const buildEvaluatorQaPrompt = (artifactDir: string, sprint: number, attempt: number) => {
  const files = buildArtifactPaths(artifactDir);
  return [
    `QA sprint ${sprint}, attempt ${attempt}.`,
    `Read ${files.spec}, ${files.contract}, ${files.handoff}, ${files.manifest}, and inspect the codebase/runtime directly as needed.`,
    'Grade the result on four criteria from 1 to 5: product depth, functionality, visual design, and code quality.',
    'If any criterion is below 4, or if the sprint contract is not satisfied, the sprint fails.',
    `Write the structured review into ${files.evaluation} and refresh ${files.handoff} with precise fix guidance.`,
    'Be skeptical and concrete. Do not ask the user questions.',
    'Reply using exactly these tags on separate lines:',
    'EVALUATION_DECISION: PASS or FAIL',
    'EVALUATION_PRODUCT_DEPTH: <1-5>',
    'EVALUATION_FUNCTIONALITY: <1-5>',
    'EVALUATION_VISUAL_DESIGN: <1-5>',
    'EVALUATION_CODE_QUALITY: <1-5>',
    'EVALUATION_SUMMARY: <one short paragraph>',
    'EVALUATION_BLOCKERS: <one line>',
  ].join('\n');
};

export const runHarnessOrchestration = async ({
  entrySessionId,
  options,
  bootstrapHarness,
  findSession,
  runRoleTurn,
  onProgress,
}: HarnessOrchestratorInput): Promise<HarnessRunResult> => {
  const normalizedOptions = {
    ...defaultOptions,
    ...options,
  };
  const bootstrap = await bootstrapHarness(entrySessionId);
  const plannerSession = await findSession(bootstrap.plannerSessionId);
  const generatorSession = await findSession(bootstrap.generatorSessionId);
  const evaluatorSession = await findSession(bootstrap.evaluatorSessionId);

  if (!plannerSession || !generatorSession || !evaluatorSession) {
    throw new Error('Harness sessions could not be resolved after bootstrap.');
  }

  const rootSessionId = plannerSession.harness?.rootSessionId ?? entrySessionId;
  const rootSession = await findSession(rootSessionId);
  if (!rootSession) {
    throw new Error('Root harness session could not be resolved.');
  }

  const manifestPath = buildArtifactPaths(bootstrap.artifactDir).manifest;
  const manifest = await loadManifest(bootstrap.artifactDir, rootSession, bootstrap, normalizedOptions);
  manifest.status = 'running';
  appendTimeline(manifest, {
    at: new Date().toISOString(),
    role: 'system',
    stage: 'bootstrap',
    sprint: manifest.currentSprint,
    round: 0,
    decision: 'STARTED',
    details: `Entry session ${entrySessionId}`,
  });
  await persistManifest(manifestPath, manifest);
  await onProgress?.(
    toHarnessSessionState(manifest, undefined, 'Harness bootstrapped. Planner is preparing the product spec.'),
  );

  manifest.currentStage = 'planning';
  await onProgress?.(
    toHarnessSessionState(manifest, 'planner', 'Planner is expanding the task into a product spec and execution plan.'),
  );
  const plannerResponse = await runRoleTurn({
    sessionId: plannerSession.id,
    prompt: buildPlannerPrompt(rootSession, bootstrap.artifactDir),
    model: normalizedOptions.model,
    effort: normalizedOptions.effort,
  });
  const plannerStatus = readDecision(plannerResponse.content, 'PLANNER_STATUS', ['READY']) || 'READY';
  appendTimeline(manifest, {
    at: new Date().toISOString(),
    role: 'planner',
    stage: 'planning',
    sprint: 0,
    round: 1,
    decision: plannerStatus,
    details: readTaggedValue(plannerResponse.content, 'PLANNER_NEXT_SPRINT') || readTaggedValue(plannerResponse.content, 'PLANNER_SUMMARY'),
  });
  await persistManifest(manifestPath, manifest);
  await onProgress?.(
    toHarnessSessionState(manifest, 'planner', readTaggedValue(plannerResponse.content, 'PLANNER_SUMMARY') || 'Planner finished the initial product spec.'),
  );

  for (let sprint = manifest.completedSprints + 1; sprint <= normalizedOptions.maxSprints; sprint += 1) {
    let contractApproved = false;

    for (let contractRound = 1; contractRound <= normalizedOptions.maxContractRounds; contractRound += 1) {
      manifest.currentStage = 'contract-proposal';
      manifest.currentSprint = sprint;
      await onProgress?.(
        toHarnessSessionState(
          manifest,
          'generator',
          `Generator is drafting sprint ${sprint} contract${contractRound > 1 ? `, round ${contractRound}` : ''}.`,
          contractRound,
        ),
      );
      const generatorContractResponse = await runRoleTurn({
        sessionId: generatorSession.id,
        prompt: buildGeneratorContractPrompt(bootstrap.artifactDir, sprint),
        model: normalizedOptions.model,
        effort: normalizedOptions.effort,
      });
      const sprintStatus = readDecision(generatorContractResponse.content, 'SPRINT_STATUS', ['READY', 'DONE']);
      appendTimeline(manifest, {
        at: new Date().toISOString(),
        role: 'generator',
        stage: 'contract-proposal',
        sprint,
        round: contractRound,
        decision: sprintStatus || 'READY',
        details: readTaggedValue(generatorContractResponse.content, 'SPRINT_GOAL') || readTaggedValue(generatorContractResponse.content, 'SPRINT_SUMMARY'),
      });
      await persistManifest(manifestPath, manifest);
      await onProgress?.(
        toHarnessSessionState(
          manifest,
          'generator',
          readTaggedValue(generatorContractResponse.content, 'SPRINT_SUMMARY') ||
            readTaggedValue(generatorContractResponse.content, 'SPRINT_GOAL') ||
            `Generator finished sprint ${sprint} contract proposal.`,
        ),
      );

      if (sprintStatus === 'DONE') {
        manifest.status = 'completed';
        manifest.currentStage = 'done';
        manifest.lastDecision = 'DONE';
        await persistManifest(manifestPath, manifest);
        await onProgress?.(
          toHarnessSessionState(manifest, undefined, 'Harness decided the task is complete without another sprint.'),
        );
        return {
          projects: bootstrap.projects,
          rootSessionId: rootSession.id,
          plannerSessionId: bootstrap.plannerSessionId,
          generatorSessionId: bootstrap.generatorSessionId,
          evaluatorSessionId: bootstrap.evaluatorSessionId,
          artifactDir: bootstrap.artifactDir,
          status: 'completed',
          completedSprints: manifest.completedSprints,
          lastDecision: 'DONE',
        };
      }

      manifest.currentStage = 'contract-review';
      await onProgress?.(
        toHarnessSessionState(
          manifest,
          'evaluator',
          `Evaluator is reviewing sprint ${sprint} contract${contractRound > 1 ? `, round ${contractRound}` : ''}.`,
          contractRound,
        ),
      );
      const evaluatorContractResponse = await runRoleTurn({
        sessionId: evaluatorSession.id,
        prompt: buildEvaluatorContractPrompt(bootstrap.artifactDir, sprint),
        model: normalizedOptions.model,
        effort: normalizedOptions.effort,
      });
      const contractDecision = readDecision(evaluatorContractResponse.content, 'CONTRACT_DECISION', ['APPROVED', 'REVISE']);
      appendTimeline(manifest, {
        at: new Date().toISOString(),
        role: 'evaluator',
        stage: 'contract-review',
        sprint,
        round: contractRound,
        decision: contractDecision || 'REVISE',
        details: readTaggedValue(evaluatorContractResponse.content, 'CONTRACT_REASON'),
      });
      await persistManifest(manifestPath, manifest);
      await onProgress?.(
        toHarnessSessionState(
          manifest,
          'evaluator',
          readTaggedValue(evaluatorContractResponse.content, 'CONTRACT_REASON') || 'Evaluator finished contract review.',
        ),
      );

      if (contractDecision === 'APPROVED') {
        contractApproved = true;
        break;
      }
    }

    if (!contractApproved) {
      manifest.status = 'failed';
      manifest.currentStage = 'contract-failed';
      manifest.lastDecision = 'CONTRACT_REJECTED';
      await persistManifest(manifestPath, manifest);
      await onProgress?.(
        toHarnessSessionState(manifest, 'evaluator', 'Harness failed because the sprint contract could not be approved.'),
      );
      return {
        projects: bootstrap.projects,
        rootSessionId: rootSession.id,
        plannerSessionId: bootstrap.plannerSessionId,
        generatorSessionId: bootstrap.generatorSessionId,
        evaluatorSessionId: bootstrap.evaluatorSessionId,
        artifactDir: bootstrap.artifactDir,
        status: 'failed',
        completedSprints: manifest.completedSprints,
        lastDecision: 'CONTRACT_REJECTED',
      };
    }

    let sprintPassed = false;

    for (let attempt = 1; attempt <= normalizedOptions.maxImplementationRounds; attempt += 1) {
      manifest.currentStage = 'implementation';
      manifest.currentSprint = sprint;
      await onProgress?.(
        toHarnessSessionState(
          manifest,
          'generator',
          `Generator is implementing sprint ${sprint}, attempt ${attempt}.`,
          attempt,
        ),
      );
      const implementationResponse = await runRoleTurn({
        sessionId: generatorSession.id,
        prompt: buildGeneratorImplementationPrompt(bootstrap.artifactDir, sprint, attempt),
        model: normalizedOptions.model,
        effort: normalizedOptions.effort,
      });
      appendTimeline(manifest, {
        at: new Date().toISOString(),
        role: 'generator',
        stage: 'implementation',
        sprint,
        round: attempt,
        decision: readDecision(implementationResponse.content, 'IMPLEMENTATION_STATUS', ['COMPLETE']) || 'COMPLETE',
        details: readTaggedValue(implementationResponse.content, 'IMPLEMENTATION_SUMMARY') || readTaggedValue(implementationResponse.content, 'IMPLEMENTATION_CHECKS'),
      });
      await persistManifest(manifestPath, manifest);
      await onProgress?.(
        toHarnessSessionState(
          manifest,
          'generator',
          readTaggedValue(implementationResponse.content, 'IMPLEMENTATION_SUMMARY') ||
            `Generator completed implementation attempt ${attempt}.`,
        ),
      );

      manifest.currentStage = 'qa';
      await onProgress?.(
        toHarnessSessionState(
          manifest,
          'evaluator',
          `Evaluator is validating sprint ${sprint}, attempt ${attempt}.`,
          attempt,
        ),
      );
      const qaResponse = await runRoleTurn({
        sessionId: evaluatorSession.id,
        prompt: buildEvaluatorQaPrompt(bootstrap.artifactDir, sprint, attempt),
        model: normalizedOptions.model,
        effort: normalizedOptions.effort,
      });
      const qaDecision = readDecision(qaResponse.content, 'EVALUATION_DECISION', ['PASS', 'FAIL']);
      const scoreSummary = [
        `pd=${readScore(qaResponse.content, 'EVALUATION_PRODUCT_DEPTH')}`,
        `fn=${readScore(qaResponse.content, 'EVALUATION_FUNCTIONALITY')}`,
        `vd=${readScore(qaResponse.content, 'EVALUATION_VISUAL_DESIGN')}`,
        `cq=${readScore(qaResponse.content, 'EVALUATION_CODE_QUALITY')}`,
      ].join(' ');
      appendTimeline(manifest, {
        at: new Date().toISOString(),
        role: 'evaluator',
        stage: 'qa',
        sprint,
        round: attempt,
        decision: qaDecision || 'FAIL',
        details: `${scoreSummary} ${readTaggedValue(qaResponse.content, 'EVALUATION_SUMMARY') || readTaggedValue(qaResponse.content, 'EVALUATION_BLOCKERS')}`.trim(),
      });
      await persistManifest(manifestPath, manifest);
      await onProgress?.(
        toHarnessSessionState(
          manifest,
          'evaluator',
          readTaggedValue(qaResponse.content, 'EVALUATION_SUMMARY') ||
            readTaggedValue(qaResponse.content, 'EVALUATION_BLOCKERS') ||
            'Evaluator completed QA.',
        ),
      );

      if (qaDecision === 'PASS') {
        manifest.completedSprints = sprint;
        sprintPassed = true;
        await onProgress?.(
          toHarnessSessionState(manifest, 'evaluator', `Sprint ${sprint} passed QA.`),
        );
        break;
      }
    }

    if (!sprintPassed) {
      manifest.status = 'failed';
      manifest.currentStage = 'qa-failed';
      manifest.lastDecision = 'SPRINT_FAILED';
      await persistManifest(manifestPath, manifest);
      await onProgress?.(
        toHarnessSessionState(manifest, 'evaluator', 'Harness failed because the sprint could not pass QA.'),
      );
      return {
        projects: bootstrap.projects,
        rootSessionId: rootSession.id,
        plannerSessionId: bootstrap.plannerSessionId,
        generatorSessionId: bootstrap.generatorSessionId,
        evaluatorSessionId: bootstrap.evaluatorSessionId,
        artifactDir: bootstrap.artifactDir,
        status: 'failed',
        completedSprints: manifest.completedSprints,
        lastDecision: 'SPRINT_FAILED',
      };
    }
  }

  manifest.status = 'completed';
  manifest.currentStage = 'finished';
  manifest.lastDecision = 'MAX_SPRINTS_REACHED';
  await persistManifest(manifestPath, manifest);
  await onProgress?.(
    toHarnessSessionState(manifest, undefined, 'Harness completed the configured sprint plan.'),
  );
  return {
    projects: bootstrap.projects,
    rootSessionId: rootSession.id,
    plannerSessionId: bootstrap.plannerSessionId,
    generatorSessionId: bootstrap.generatorSessionId,
    evaluatorSessionId: bootstrap.evaluatorSessionId,
    artifactDir: bootstrap.artifactDir,
    status: 'completed',
    completedSprints: manifest.completedSprints,
    lastDecision: 'MAX_SPRINTS_REACHED',
  };
};
