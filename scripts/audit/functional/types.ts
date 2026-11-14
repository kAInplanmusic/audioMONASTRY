import type { Page } from 'playwright';
export type FunctionalRole = 'producer' | 'generator' | 'mastering' | 'eq';
export interface AssertionResult { assertion: string; passed: boolean; detail?: unknown; at: string }
export interface RoleContext {
 role: FunctionalRole; page: Page; pages: Record<FunctionalRole, Page>; outputPage: Page;
 directory: string; startedAt: number; deadline: number;
 record: (assertion: string, passed: boolean, detail?: unknown) => void;
}
