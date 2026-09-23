import type { z } from 'zod';

/** The composition root supplies trusted-sender checks around each validated action. */
export type Register = <T>(name: string, schema: z.ZodType<T>, action: (data: T) => unknown) => void;
