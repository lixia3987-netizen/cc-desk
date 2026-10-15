import type { z } from 'zod';

/** 组合根在每个已验证操作外包裹可信发送方检查。 */
export type Register = <T>(name: string, schema: z.ZodType<T>, action: (data: T) => unknown) => void;
