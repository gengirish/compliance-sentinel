---
name: testing-patterns
description: >-
  Testing patterns for ComplianceForge: Vitest for unit tests, Playwright for E2E,
  factory functions, mocking strategies, and TDD workflow. Use when writing tests,
  creating test factories, or following TDD red-green-refactor cycle.
---

# Testing Patterns — ComplianceForge

## Testing Philosophy

**Test-Driven Development (TDD):**
- Write failing test FIRST
- Implement minimal code to pass
- Refactor after green
- Never write production code without a failing test

**Behavior-Driven Testing:**
- Test behavior, not implementation
- Focus on public APIs and business requirements
- Use descriptive test names that describe behavior

## Test Stack

| Layer | Tool | Config |
|-------|------|--------|
| Unit tests | Vitest | `vitest.config.ts` |
| E2E tests | Playwright | `playwright.config.ts` |
| Component tests | React Testing Library | via Vitest |

## Factory Pattern

### Prisma Model Factory

```typescript
import { AiSystem, Organization, User } from '@prisma/client';

const getMockOrganization = (overrides?: Partial<Organization>): Organization => ({
  id: 'org-test-001',
  name: 'Test Corp',
  slug: 'test-corp',
  domain: 'test.com',
  plan: 'pro',
  maxSystems: 10,
  stripeCustomerId: null,
  stripeSubscriptionId: null,
  agentmailInboxId: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

const getMockAiSystem = (overrides?: Partial<AiSystem>): AiSystem => ({
  id: 'sys-test-001',
  name: 'Test AI System',
  description: 'A test AI system',
  sector: 'healthcare',
  useCase: 'diagnostic',
  provider: 'TestProvider',
  version: '1.0',
  riskTier: 'high',
  complianceStatus: 'in_progress',
  complianceScore: 65,
  organizationId: 'org-test-001',
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});
```

## Mocking Patterns

### Mocking Prisma

```typescript
import { vi } from 'vitest';

vi.mock('@/server/db', () => ({
  prisma: {
    aiSystem: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    organization: {
      findUnique: vi.fn(),
    },
  },
}));
```

### Mocking NextAuth

```typescript
vi.mock('next-auth', () => ({
  getServerSession: vi.fn(() => ({
    user: { id: 'user-001', email: 'test@test.com', organizationId: 'org-001' },
  })),
}));
```

## Test Structure

```typescript
describe('ComplianceScoringService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('calculateScore', () => {
    it('should return 0 for system with no assessments', () => {});
    it('should weight high-risk requirements more heavily', () => {});
    it('should cap score at 100', () => {});
  });

  describe('getRiskTier', () => {
    it('should classify healthcare AI as high risk', () => {});
    it('should classify general-purpose AI as limited risk', () => {});
  });
});
```

## E2E Test Pattern

```typescript
import { test, expect } from '@playwright/test';

test.describe('Dashboard', () => {
  test.beforeEach(async ({ page }) => {
    // Login
    await page.goto('/sign-in');
    await page.fill('input[name="email"]', 'admin@test.com');
    await page.fill('input[name="password"]', 'testpass123');
    await page.click('button[type="submit"]');
    await page.waitForURL('/dashboard');
  });

  test('should display compliance score', async ({ page }) => {
    await expect(page.getByText(/compliance score/i)).toBeVisible();
  });
});
```

## Running Tests

```bash
# Unit tests
npx vitest                    # Watch mode
npx vitest run                # Single run
npx vitest run --coverage     # With coverage

# E2E tests
npx playwright test           # All tests
npx playwright test --ui      # Interactive mode
npx playwright test e2e/passport.spec.ts  # Single file
```

## Anti-Patterns to Avoid

| Don't | Do |
|-------|----|
| Test mock behavior | Test actual behavior via assertions on rendered output |
| Duplicate test data | Use factory functions with overrides |
| Test implementation details | Test public API and behavior |
| Skip auth in E2E | Always test through the auth flow |
| Hardcode UUIDs in assertions | Use flexible matchers |

## Compliance-Specific Test Cases

Always test these for compliance features:
- Risk tier classification accuracy
- Score calculation correctness
- EU AI Act article mapping
- Deadline enforcement dates
- Passport public visibility rules
- API key authentication and authorization
- Multi-tenant data isolation
