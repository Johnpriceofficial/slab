-- GradedCardValue.com — defense in depth for server-only eBay data.
-- The private schema is not in the Data API exposed schemas and all client
-- grants are revoked. RLS with no client policies adds a second independent
-- barrier; Supabase service-role operations continue to bypass RLS.

alter table private.ebay_oauth_credentials enable row level security;
alter table private.ebay_oauth_states enable row level security;
alter table private.ebay_orders enable row level security;
alter table private.ebay_order_line_items enable row level security;
alter table private.ebay_fulfillments enable row level security;
alter table private.ebay_financial_transactions enable row level security;

create index if not exists ebay_oauth_states_requested_by_idx
  on private.ebay_oauth_states (requested_by);
create index if not exists ebay_order_line_items_slab_idx
  on private.ebay_order_line_items (slab_id);

revoke all on all tables in schema private from anon, authenticated;
revoke all on all sequences in schema private from anon, authenticated;

comment on schema private is
  'Server-only integration data. Not exposed through the Data API; client grants revoked and RLS enabled with no client policies.';
