-- People who asked for the weekly digest from the website. Double opt-in: a row starts
-- pending and only the emailed confirmation link makes it active. The token is the only
-- credential the emails carry, for confirming and for unsubscribing without a sign-in.
CREATE TABLE IF NOT EXISTS digest_subscribers (
  id bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  email text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'unsubscribed')),
  token text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  confirmation_sent_at timestamptz,
  confirmed_at timestamptz,
  unsubscribed_at timestamptz
);
CREATE INDEX IF NOT EXISTS digest_subscribers_active_idx ON digest_subscribers (status) WHERE status = 'active';
