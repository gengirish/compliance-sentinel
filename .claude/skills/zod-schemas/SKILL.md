---
name: zod-schemas
description: >-
  Zod validation patterns for AyushOS. Use when creating API input schemas,
  DTOs, env parsers, form schemas, or worker job payloads in lib/validators/.
---

# Zod Schemas — AyushOS

Package: `zod`  
Location: `lib/validators/` (barrel re-export in `lib/validators/index.ts`)

## Schema Organization

```
lib/validators/
├── patient.ts       # Patient, Aadhaar/ABHA, address, consent
├── consultation.ts  # Consultation + diagnosis schemas
├── dispensing.ts    # Dispensing / pharmacy schemas
├── admission.ts     # IPD admission schemas
├── discharge.ts     # Discharge summary schemas
├── stock.ts         # Inventory / stock schemas
├── attendance.ts    # Staff attendance schemas
├── appointment.ts   # Appointment + token schemas
└── index.ts         # Re-exports everything
```

## Pattern: Input Schema + DTO

```typescript
import { z } from "zod";

// API input (what clients send)
export const CreateOrderInput = z.object({
  buyerName: z.string().min(1),
  buyerEmail: z.string().email(),
  buyerPhone: z.string().regex(/^\+91\d{10}$/, "Must be +91 followed by 10 digits"),
  shippingAddress: AddressSchema,
  billingAddress: AddressSchema,
  items: z.array(OrderItemInput).min(1),
  currency: z.enum(["INR", "USD", "EUR", "GBP"]).default("INR"),
  notes: z.string().optional(),
});
export type CreateOrderInput = z.infer<typeof CreateOrderInput>;

// DTO (what API returns)
export const OrderDTO = z.object({
  id: z.string(),
  orderNumber: z.string(),
  status: z.nativeEnum(OrderStatus),
  totalPaise: z.number().int(),
  totalFormatted: z.string(),
  createdAt: z.string().datetime(),
});
export type OrderDTO = z.infer<typeof OrderDTO>;
```

## Indian Conventions in Schemas

```typescript
// Phone: +91 prefix, 10-digit
const IndianPhone = z.string().regex(/^\+91\d{10}$/);

// Money: always integer paise, never float
const MoneyPaise = z.number().int().nonnegative();

// GSTIN: 15-char alphanumeric
const GSTIN = z.string().regex(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/);

// Address with PIN code
const AddressSchema = z.object({
  line1: z.string().min(1),
  line2: z.string().optional(),
  city: z.string().min(1),
  state: z.string().min(1),
  pin: z.string().regex(/^\d{6}$/, "Must be 6-digit PIN code"),
  country: z.string().default("IN"),
});

// Monetary response (always dual format)
const MoneyResponse = z.object({
  amountPaise: z.number().int(),
  amountFormatted: z.string(), // "₹1,23,456.00"
});
```

## Environment Parsing (lib/env.ts)

```typescript
import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  CLERK_SECRET_KEY: z.string().startsWith("sk_"),
  FLY_WORKER_URL: z.string().url(),
  WORKER_SECRET: z.string().min(32),
  RAZORPAY_KEY_SECRET: z.string(),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
});

export const env = envSchema.parse(process.env);
```

## API Response Schema

```typescript
export const ApiResponse = <T extends z.ZodType>(dataSchema: T) =>
  z.object({
    success: z.boolean(),
    data: dataSchema.optional(),
    error: z
      .object({
        code: z.string(),
        message: z.string(),
      })
      .optional(),
  });

export const PaginatedResponse = <T extends z.ZodType>(itemSchema: T) =>
  z.object({
    items: z.array(itemSchema),
    total: z.number().int(),
    page: z.number().int().positive(),
    pageSize: z.number().int().positive(),
    hasMore: z.boolean(),
  });
```

## Worker Job Payload Schemas

```typescript
export const OrderJobPayload = z.object({
  orderId: z.string(),
  tenantId: z.string(),
  action: z.enum(["FULFILL", "CANCEL", "REFUND"]),
});

export const InvoiceJobPayload = z.object({
  orderId: z.string(),
  tenantId: z.string(),
});
```

## Conventions

- Schema name matches type name: `CreateOrderInput` (both schema and type)
- All inputs validated at boundary (API route, server action, worker job entry)
- Never trust data past the boundary — always parse with Zod first
- Export both schema and inferred type from `lib/validators`
- Use `z.nativeEnum()` for Prisma enums
