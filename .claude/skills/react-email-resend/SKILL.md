---
name: react-email-resend
description: >-
  React Email templates + Resend delivery for DropFlow transactional emails.
  Use when creating email templates for order confirmations, shipping updates,
  invoices, or low-stock alerts.
---

# React Email + Resend — DropFlow

Packages: `react-email`, `@react-email/components`, `resend`

## Setup

```bash
pnpm add resend @react-email/components --filter worker
pnpm add -D react-email --filter worker
```

## Email Template Pattern

File: `apps/worker/src/emails/order-shipped.tsx`

```typescript
import {
  Body, Container, Head, Heading, Html, Preview, Section,
  Text, Button, Row, Column, Hr,
} from "@react-email/components";

interface OrderShippedEmailProps {
  orderNumber: string;
  buyerName: string;
  trackingUrl: string;
  carrier: string;
  estimatedDelivery: string;
  items: { name: string; quantity: number; totalFormatted: string }[];
}

export function OrderShippedEmail({
  orderNumber, buyerName, trackingUrl, carrier, estimatedDelivery, items,
}: OrderShippedEmailProps) {
  return (
    <Html>
      <Head />
      <Preview>Your order {orderNumber} has been shipped</Preview>
      <Body style={{ fontFamily: "Arial, sans-serif", backgroundColor: "#f6f9fc" }}>
        <Container style={{ maxWidth: "600px", margin: "0 auto", padding: "20px" }}>
          <Heading style={{ fontSize: "24px" }}>Order Shipped</Heading>
          <Text>Hi {buyerName},</Text>
          <Text>
            Your order <strong>{orderNumber}</strong> has been shipped via {carrier}.
            Estimated delivery: {estimatedDelivery}.
          </Text>

          <Button
            href={trackingUrl}
            style={{
              backgroundColor: "#000",
              color: "#fff",
              padding: "12px 24px",
              borderRadius: "6px",
              textDecoration: "none",
            }}
          >
            Track Your Order
          </Button>

          <Hr />

          <Section>
            <Heading as="h3">Items</Heading>
            {items.map((item, i) => (
              <Row key={i}>
                <Column>{item.name} x{item.quantity}</Column>
                <Column align="right">{item.totalFormatted}</Column>
              </Row>
            ))}
          </Section>
        </Container>
      </Body>
    </Html>
  );
}
```

## Sending via Resend

```typescript
import { Resend } from "resend";
import { OrderShippedEmail } from "../emails/order-shipped";

const resend = new Resend(env.RESEND_API_KEY);

export async function sendOrderShippedEmail(order: Order, shipment: Shipment) {
  await resend.emails.send({
    from: "DropFlow <orders@dropflow.in>",
    to: order.buyerEmail,
    subject: `Order ${order.orderNumber} has been shipped`,
    react: OrderShippedEmail({
      orderNumber: order.orderNumber,
      buyerName: order.buyerName,
      trackingUrl: shipment.trackingUrl!,
      carrier: shipment.carrier,
      estimatedDelivery: format(shipment.estimatedDelivery!, "dd/MM/yyyy"),
      items: order.items.map(i => ({
        name: i.product.name,
        quantity: i.quantity,
        totalFormatted: formatPaise(i.totalPaise),
      })),
    }),
  });
}
```

## Email Templates to Build

| Template | Trigger | Recipient |
|----------|---------|-----------|
| `order-confirmed.tsx` | Order created + payment captured | Buyer |
| `order-shipped.tsx` | Shipment created | Buyer |
| `order-delivered.tsx` | Carrier confirms delivery | Buyer |
| `invoice-email.tsx` | Invoice generated (attach PDF) | Buyer |
| `low-stock-alert.tsx` | Stock below threshold | Seller admin |
| `supplier-po.tsx` | Purchase order created | Supplier |
| `welcome.tsx` | Tenant onboarding | Seller admin |

## Development Preview

```bash
cd apps/worker
npx react-email dev
```

Opens a browser preview at `localhost:3001` to iterate on templates.

## Conventions

- All money amounts formatted with `en-IN` locale and ₹ symbol
- Dates formatted as DD/MM/YYYY (Indian convention)
- Include order number in every transactional email subject line
- Use Resend webhooks to track delivery/bounce events
- Never include sensitive data (payment details, GSTIN) in email body
