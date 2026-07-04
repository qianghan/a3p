import type { DocumentRequirement } from '@agentbook/jurisdictions';

export function buildExtractionPrompt(_docType: string, requirement: DocumentRequirement): string {
  return `This document should be a "${requirement.label}": ${requirement.description}\n\nExtract the key structured data from it. Respond with ONLY compact JSON — no markdown, no prose. Include a "confidence" field from 0 to 1 reflecting how well this document matches the expected type ("${requirement.label}"). If a field is unreadable or absent, omit it rather than guessing.`;
}

export function parseExtractionJson(_docType: string, text: string): Record<string, unknown> {
  try {
    const cleaned = text.replace(/```json\s*|```\s*/g, '').trim();
    const parsed = JSON.parse(cleaned);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}
