/**
 * Single current-default xAI identities for adapter, committee, paid roster,
 * and paper contracts. Image SKUs stay separate from text/vision.
 */
export const XAI_TEXT_MODEL_DEFAULT = "grok-4.6";
export const XAI_IMAGE_MODEL_DEFAULT = "grok-imagine-image-quality";

export function resolvedXaiTextModel(requested?: string): string {
  return requested?.trim() || process.env.XAI_TEXT_MODEL?.trim() || XAI_TEXT_MODEL_DEFAULT;
}
