export interface ApprovedPublicationMetadata {
  readonly schemaVersion: "1.0";
  readonly releaseVersion: string;
  readonly status: "approved";
  readonly reviewId: string;
  readonly reviewerRole: "qualified-publication-metadata-reviewer";
  readonly reviewedAt: string;
  readonly repositoryUrl: string;
  readonly homepageUrl: string;
  readonly bugsUrl: string;
  readonly registryScopeAuthority: Readonly<{ scope: "@pixel-point"; registryUrl: "https://registry.npmjs.org/"; owner: string; evidenceId: string }>;
  readonly note: string;
}
export function validateApprovedPublicationMetadata(input: unknown): ApprovedPublicationMetadata;
export function validatePublicationMetadataShape(input: unknown): Record<string, unknown>;
export function applyApprovedPublicationMetadata(source: Record<string, unknown>, input: unknown): Record<string, unknown>;
export function reconcilePublicationMetadata(manifests: readonly Record<string, unknown>[], input: unknown): ApprovedPublicationMetadata;
