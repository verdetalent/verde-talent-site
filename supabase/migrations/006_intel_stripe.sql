-- Intelligence billing through Stripe.
--
-- Stripe owns the subscription; this table mirrors it so the paywall can be checked inside
-- Postgres without calling Stripe on every page load. stripe-webhook writes it on
-- checkout.session.completed and customer.subscription.updated / deleted.
--
-- Run after 001 and 005. Safe to re-run.

alter table public.intel_subscriptions
  add column if not exists stripe_customer_id     text,
  add column if not exists stripe_subscription_id text,
  add column if not exists billing_interval       text,
  add column if not exists cancel_at_period_end   boolean not null default false;

alter table public.intel_subscriptions drop constraint if exists intel_subscriptions_billing_interval_check;
alter table public.intel_subscriptions add constraint intel_subscriptions_billing_interval_check
  check (billing_interval is null or billing_interval in ('month', 'year'));

create unique index if not exists intel_subscriptions_stripe_subscription_idx
  on public.intel_subscriptions (stripe_subscription_id) where stripe_subscription_id is not null;

-- A failed renewal leaves the subscription past_due while Stripe retries the card for a
-- couple of weeks. Keep access during those retries: cutting a paying customer off over an
-- expired card is how a retry that would have succeeded turns into a cancellation. If the
-- retries fail, Stripe cancels and the webhook sets status 'canceled'.
create or replace function public.has_intel_access()
  returns boolean
  language sql
  stable
  security definer
  set search_path = public
as $$
  select exists (
    select 1
      from public.intel_subscriptions s
     where s.user_id = auth.uid()
       and s.status in ('active', 'past_due')
       and s.current_period_end > now()
  );
$$;
