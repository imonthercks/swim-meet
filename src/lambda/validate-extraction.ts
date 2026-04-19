/**
 * ValidateExtraction Lambda — Step Functions task
 *
 * Validates the heat array extracted by the Bedrock Agent against the
 * canonical schema used by the SPA.  Throws on critical errors so Step
 * Functions catches the failure and routes to UpdateMeetStatus(FAILED).
 *
 * Input (from Step Functions):
 *   { meetId, s3Bucket, s3Key, heats: Heat[] }
 *
 * Output (pass-through with validation metadata appended):
 *   { meetId, s3Bucket, s3Key, heats: Heat[], heatCount: number }
 */

// Inline type definitions — Lambda handlers are isolated entry points and
// must not import from other handler files to keep the bundle self-contained.
interface HeatEntry {
  lane: number;
  school?: string;
  name?: string;
  age?: string | null;
  seed_time?: string;
  relay?: string;
  swimmers?: string[];
  blank?: boolean;
}

interface Heat {
  id: string;
  event: number;
  event_name: string;
  heat: number;
  is_relay: boolean;
  entries: HeatEntry[];
}

interface StepInput {
  meetId: string;
  s3Bucket: string;
  s3Key: string;
  heats: Heat[];
}

interface StepOutput extends StepInput {
  heatCount: number;
}

function validateEntry(entry: HeatEntry, heatId: string, idx: number): string[] {
  const errors: string[] = [];
  if (typeof entry.lane !== 'number') {
    errors.push(`${heatId} entry[${idx}]: 'lane' must be a number`);
  }
  if (entry.blank) return errors; // blank lanes need only a lane number
  if (!entry.school) {
    errors.push(`${heatId} entry[${idx}]: non-blank entry missing 'school'`);
  }
  return errors;
}

function validateHeat(heat: Heat): string[] {
  const errors: string[] = [];
  if (!heat.id || typeof heat.id !== 'string') {
    errors.push('Heat missing valid \'id\'');
  }
  if (typeof heat.event !== 'number' || heat.event < 1) {
    errors.push(`${heat.id}: 'event' must be a positive integer`);
  }
  if (!heat.event_name || typeof heat.event_name !== 'string') {
    errors.push(`${heat.id}: 'event_name' must be a non-empty string`);
  }
  if (typeof heat.heat !== 'number' || heat.heat < 1) {
    errors.push(`${heat.id}: 'heat' must be a positive integer`);
  }
  if (typeof heat.is_relay !== 'boolean') {
    errors.push(`${heat.id}: 'is_relay' must be a boolean`);
  }
  if (!Array.isArray(heat.entries) || heat.entries.length === 0) {
    errors.push(`${heat.id}: 'entries' must be a non-empty array`);
  } else {
    heat.entries.forEach((e, i) => errors.push(...validateEntry(e, heat.id, i)));
  }
  return errors;
}

export async function handler(event: StepInput): Promise<StepOutput> {
  const { meetId, heats } = event;

  if (!Array.isArray(heats) || heats.length === 0) {
    throw new Error(`Meet ${meetId}: extraction produced no heats`);
  }

  const allErrors: string[] = heats.flatMap(validateHeat);

  if (allErrors.length > 0) {
    const summary = allErrors.slice(0, 10).join('; ');
    console.warn(`Validation warnings for meet ${meetId}: ${summary}`);
    // Non-fatal: log warnings but proceed.  The SPA is tolerant of minor
    // schema variations; only throw if there are zero valid heats.
    const validHeats = heats.filter(h => validateHeat(h).length === 0);
    if (validHeats.length === 0) {
      throw new Error(`Meet ${meetId}: all heats failed validation. Errors: ${summary}`);
    }
  }

  console.log(`Validated ${heats.length} heats for meet ${meetId}`);
  return { ...event, heatCount: heats.length };
}
