import { ElementCleanupIncompleteError } from "./errors.js";
import type { ElementHostEnvironmentSnapshot } from "./element-host-environment.js";
import type { ElementInputBindingSnapshot } from "./element-input-binding.js";
import type {
  PageDecoderTicketState,
  PageResourcesSnapshot
} from "./page-resources.js";
import type { PlayerSnapshot } from "./player-contract.js";
import type {
  AvalCleanupReceipt,
  AvalElementOwnershipSnapshot,
  AvalTerminalCleanupProof
} from "./public-types.js";

export interface InputBindingOwnership {
  readonly kind: "input-binding";
  readonly listenerCount: number;
  readonly failedReleaseCount: number;
}

export interface HostEnvironmentOwnership {
  readonly kind: "host-environment";
  readonly listenerCount: number;
  readonly observerCount: number;
  readonly failedListenerReleaseCount: number;
  readonly failedObserverReleaseCount: number;
}

export interface PageResourceOwnership {
  readonly kind: "page-resources";
  readonly participantDisposed: boolean;
  readonly participantRegistered: boolean;
  readonly logicalBytes: number;
  readonly activeLeaseCount: number;
  readonly decoderTicketCount: number;
  readonly decoderState: PageDecoderTicketState | null;
}

export interface ElementOwnershipSnapshot {
  readonly completed: boolean;
  readonly terminal: boolean;
  readonly input: Readonly<InputBindingOwnership>;
  readonly host: Readonly<HostEnvironmentOwnership>;
  readonly timers: number;
  readonly deferredOperations: number;
}

export interface PlayerCleanupProof {
  readonly kind: "player";
  readonly completed: boolean;
  readonly workerCount: number;
  readonly openFrames: number;
  readonly declaredFileBytes: number;
  readonly metadataBytes: number;
  readonly verifiedBytes: number;
  readonly residentBlobBytes: number;
  readonly activeTransportBodies: number;
  readonly pendingLoads: number;
  readonly interestedWaiters: number;
  readonly pendingRuntimeOperations: number;
  readonly sourceCopiesInFlight: number;
  readonly rendererStagingBytes: number;
  readonly rendererResourceCount: number;
  readonly contextListenerCount: number;
}

export interface SourceCleanupReceipt {
  readonly completed: boolean;
  readonly generation: number;
  readonly sourceGeneration: number;
  readonly failureCount: number;
  readonly operationFailed: boolean;
  readonly player: Readonly<PlayerCleanupProof> | null;
  readonly pageResources: Readonly<PageResourceOwnership>;
  readonly page: Readonly<PageResourcesSnapshot>;
  readonly stalePublicationCount: number;
  readonly terminal: boolean;
  readonly retiredDeclaredFileBytes: number;
}

export interface ElementTerminalCleanupProof {
  readonly completed: boolean;
  readonly sourceCleanupCompleted: boolean;
  readonly presentationCleanupCompleted: boolean;
  readonly element: Readonly<ElementOwnershipSnapshot>;
}

export interface SerializedSourceCleanupReceipt extends AvalCleanupReceipt {
  readonly terminal: boolean;
  readonly retiredDeclaredFileBytes: number;
}

export interface SerializedElementTerminalCleanupProof
  extends AvalTerminalCleanupProof {
  readonly presentationCleanupCompleted: boolean;
}

export interface ElementOwnershipInput {
  readonly terminal: boolean;
  readonly input: Pick<
    ElementInputBindingSnapshot,
    "listenerCount" | "failedReleaseCount"
  >;
  readonly host: Pick<
    ElementHostEnvironmentSnapshot,
    | "listenerCount"
    | "observerCount"
    | "failedListenerReleaseCount"
    | "failedObserverReleaseCount"
  >;
  readonly deferredOperationCount: number;
  readonly timerCount?: number;
}

export interface SourceCleanupInput {
  readonly generation: number;
  readonly sourceGeneration: number;
  readonly runtime: Readonly<PlayerSnapshot> | null;
  readonly page: Readonly<PageResourcesSnapshot>;
  readonly retiredDeclaredFileBytes: number;
  readonly operationFailed: boolean;
  readonly pageResources: Readonly<PageResourceOwnership>;
  readonly terminal: boolean;
  readonly stalePublicationCount?: number;
}

const cleanupSerializations = new WeakMap<
  SourceCleanupReceipt,
  Readonly<SerializedSourceCleanupReceipt>
>();
const terminalSerializations = new WeakMap<
  ElementTerminalCleanupProof,
  Readonly<SerializedElementTerminalCleanupProof>
>();

export function createPageResourceOwnership(
  participantDisposed: boolean,
  logicalBytes: number,
  decoderState: PageDecoderTicketState | null
): Readonly<PageResourceOwnership> {
  return Object.freeze({
    kind: "page-resources",
    participantDisposed,
    participantRegistered: !participantDisposed,
    logicalBytes,
    activeLeaseCount: decoderState === "granted" ? 1 : 0,
    decoderTicketCount: decoderState === null ? 0 : 1,
    decoderState
  });
}

export function createElementOwnershipSnapshot(
  input: Readonly<ElementOwnershipInput>
): Readonly<ElementOwnershipSnapshot> {
  const inputOwnership = Object.freeze({
    kind: "input-binding" as const,
    listenerCount: input.input.listenerCount,
    failedReleaseCount: input.input.failedReleaseCount
  });
  const host = Object.freeze({
    kind: "host-environment" as const,
    listenerCount: input.host.listenerCount,
    observerCount: input.host.observerCount,
    failedListenerReleaseCount: input.host.failedListenerReleaseCount,
    failedObserverReleaseCount: input.host.failedObserverReleaseCount
  });
  const timers = input.timerCount ?? 0;
  const completed = input.terminal &&
    inputOwnership.listenerCount === 0 &&
    inputOwnership.failedReleaseCount === 0 &&
    host.listenerCount === 0 && host.observerCount === 0 &&
    host.failedListenerReleaseCount === 0 &&
    host.failedObserverReleaseCount === 0 &&
    timers === 0 &&
    input.deferredOperationCount === 0;
  return Object.freeze({
    completed,
    terminal: input.terminal,
    input: inputOwnership,
    host,
    timers,
    deferredOperations: input.deferredOperationCount
  });
}

export function serializeElementOwnershipSnapshot(
  snapshot: Readonly<ElementOwnershipSnapshot>
): Readonly<AvalElementOwnershipSnapshot> {
  const failedReleaseCount = snapshot.input.failedReleaseCount +
    snapshot.host.failedListenerReleaseCount +
    snapshot.host.failedObserverReleaseCount;
  return Object.freeze({
    listenerCount: snapshot.input.listenerCount + snapshot.host.listenerCount,
    observerCount: snapshot.host.observerCount,
    brokerSubscriptionCount: 0,
    timerCount: snapshot.timers,
    pendingCommandCount: snapshot.deferredOperations,
    failedReleaseCount,
    retainedRetryCount: failedReleaseCount,
    releaseFailureCount: failedReleaseCount,
    completed: snapshot.completed
  });
}

export function createSourceCleanupReceipt(
  input: Readonly<SourceCleanupInput>
): Readonly<SourceCleanupReceipt> {
  const player = readPlayerCleanupProof(input.runtime);
  const pageResources = input.pageResources;
  const failureCount = [
    input.operationFailed,
    player === null,
    player?.completed !== true,
    !pageResources.participantDisposed,
    pageResources.participantRegistered,
    pageResources.logicalBytes !== 0,
    pageResources.activeLeaseCount !== 0,
    pageResources.decoderTicketCount !== 0
  ].filter(Boolean).length;
  return Object.freeze({
    completed: failureCount === 0,
    generation: input.generation,
    sourceGeneration: input.sourceGeneration,
    failureCount,
    operationFailed: input.operationFailed,
    player,
    pageResources,
    page: Object.freeze({ ...input.page }),
    stalePublicationCount: input.stalePublicationCount ?? 0,
    terminal: input.terminal,
    retiredDeclaredFileBytes: input.retiredDeclaredFileBytes
  });
}

export function serializeSourceCleanupReceipt(
  receipt: Readonly<SourceCleanupReceipt>
): Readonly<SerializedSourceCleanupReceipt> {
  const retained = cleanupSerializations.get(receipt);
  if (retained !== undefined) return retained;
  const player = receipt.player;
  const resources = receipt.pageResources;
  const serialized = Object.freeze({
    elementGeneration: receipt.generation,
    sourceGeneration: receipt.sourceGeneration,
    completed: receipt.completed,
    failureCount: receipt.failureCount,
    playerDisposed: player?.completed ?? false,
    participantDisposed: resources.participantDisposed,
    participantRegistered: resources.participantRegistered,
    participantLogicalBytes: resources.logicalBytes,
    participantActiveLeaseCount: resources.activeLeaseCount,
    participantRegisteredCleanupCount: 0,
    participantTrackedWorkCount: 0,
    participantPendingWaitCount: 0,
    participantDecoderTicketCount: resources.decoderTicketCount,
    participantDecoderState: resources.decoderState,
    workerCount: player?.workerCount ?? 0,
    openFrames: player?.openFrames ?? 0,
    pendingRuntimeOperations: player?.pendingRuntimeOperations ?? 0,
    sourceCopiesInFlight: player?.sourceCopiesInFlight ?? 0,
    rendererStagingBytes: player?.rendererStagingBytes ?? 0,
    pendingLoads: player?.pendingLoads ?? 0,
    activeTransportBodies: player?.activeTransportBodies ?? 0,
    interestedWaiters: player?.interestedWaiters ?? 0,
    rendererResourceCount: player?.rendererResourceCount ?? 0,
    contextListenerCount: player?.contextListenerCount ?? 0,
    stalePublicationCount: receipt.stalePublicationCount,
    pagePhysicalBytes: receipt.page.physicalBytes,
    pageParticipantCount: receipt.page.participants,
    pageActiveDecoderSlotCount: receipt.page.active,
    pageQueuedDecoderTicketCount: receipt.page.queued,
    pageParkedDecoderTicketCount: receipt.page.parked,
    terminal: receipt.terminal,
    retiredDeclaredFileBytes: receipt.retiredDeclaredFileBytes
  });
  cleanupSerializations.set(receipt, serialized);
  return serialized;
}

export function createElementTerminalCleanupProof(
  sourceCleanupCompleted: boolean,
  presentationCleanupCompleted: boolean,
  element: Readonly<ElementOwnershipSnapshot>
): Readonly<ElementTerminalCleanupProof> {
  return Object.freeze({
    completed: sourceCleanupCompleted && presentationCleanupCompleted &&
      element.completed,
    sourceCleanupCompleted,
    presentationCleanupCompleted,
    element
  });
}

export function serializeElementTerminalCleanupProof(
  proof: Readonly<ElementTerminalCleanupProof>
): Readonly<SerializedElementTerminalCleanupProof> {
  const retained = terminalSerializations.get(proof);
  if (retained !== undefined) return retained;
  const serialized = Object.freeze({
    completed: proof.completed,
    sourceCleanupCompleted: proof.sourceCleanupCompleted,
    presentationCleanupCompleted: proof.presentationCleanupCompleted,
    elementOwnership: serializeElementOwnershipSnapshot(proof.element)
  });
  terminalSerializations.set(proof, serialized);
  return serialized;
}

export function proveSourceRetirement(
  disposed: boolean,
  receipt: Readonly<SourceCleanupReceipt>
): boolean {
  if (!disposed) return false;
  if (!receipt.completed) throw new ElementCleanupIncompleteError();
  return true;
}

export function readPlayerCleanupProof(
  runtime: Readonly<PlayerSnapshot> | null
): Readonly<PlayerCleanupProof> | null {
  if (runtime === null) return null;
  const presentation = runtime.presentation;
  const rendererStagingBytes = presentation.stagingBytes ?? 0;
  const rendererResidentBytes = presentation.residentBytes ?? 0;
  const rendererTextureBytes = presentation.textureBytes ?? 0;
  const rendererRuntimeBytes = presentation.runtimeBytes ?? 0;
  const rendererBackingBytes = presentation.backingWidth *
    presentation.backingHeight;
  const observedRendererCategories = [
    rendererBackingBytes,
    rendererStagingBytes,
    rendererResidentBytes,
    rendererTextureBytes,
    rendererRuntimeBytes
  ].filter((bytes) => bytes !== 0).length;
  const rendererResourceCount = presentation.resourceCount ??
    (observedRendererCategories === 0 ? 0 : 1);
  const contextListenerCount = presentation.contextListenerCount ??
    (rendererResourceCount === 0 ? 0 : 1);
  const pendingRuntimeOperations = presentation.pendingOperations ?? 0;
  const sourceCopiesInFlight = presentation.sourceCopiesInFlight ?? 0;
  const completed = runtime.workerCount === 0 && runtime.openFrames === 0 &&
    runtime.declaredFileBytes === 0 && runtime.metadataBytes === 0 &&
    runtime.verifiedBytes === 0 && runtime.residentBlobBytes === 0 &&
    runtime.activeTransportBodies === 0 && runtime.pendingLoads === 0 &&
    runtime.interestedWaiters === 0 && pendingRuntimeOperations === 0 &&
    sourceCopiesInFlight === 0 && presentation.backingWidth === 0 &&
    presentation.backingHeight === 0 && rendererStagingBytes === 0 &&
    rendererResidentBytes === 0 && rendererTextureBytes === 0 &&
    rendererRuntimeBytes === 0 && rendererResourceCount === 0 &&
    contextListenerCount === 0;
  return Object.freeze({
    kind: "player",
    completed,
    workerCount: runtime.workerCount,
    openFrames: runtime.openFrames,
    declaredFileBytes: runtime.declaredFileBytes,
    metadataBytes: runtime.metadataBytes,
    verifiedBytes: runtime.verifiedBytes,
    residentBlobBytes: runtime.residentBlobBytes,
    activeTransportBodies: runtime.activeTransportBodies,
    pendingLoads: runtime.pendingLoads,
    interestedWaiters: runtime.interestedWaiters,
    pendingRuntimeOperations,
    sourceCopiesInFlight,
    rendererStagingBytes,
    rendererResourceCount,
    contextListenerCount
  });
}

export function playerSnapshotDisposed(
  runtime: Readonly<PlayerSnapshot> | null
): boolean {
  return readPlayerCleanupProof(runtime)?.completed === true;
}
