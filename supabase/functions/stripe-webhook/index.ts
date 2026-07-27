import Stripe from 'npm:stripe@^22';
import { createClient } from 'npm:@supabase/supabase-js@2';
import { corsHeaders } from '../_shared/cors.ts';

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!);
const webhookSecret = Deno.env.get('STRIPE_WEBHOOK_SECRET')!;
const admin = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
);

async function userIdForCustomer(customerId: string | null): Promise<string | null> {
  if (!customerId) return null;

  const { data: profile } = await admin
    .from('payment_profiles')
    .select('user_id')
    .eq('stripe_customer_id', customerId)
    .maybeSingle();

  if (profile?.user_id) return profile.user_id;

  const customer = await stripe.customers.retrieve(customerId);
  if (!customer.deleted && customer.metadata?.supabase_user_id) {
    return customer.metadata.supabase_user_id;
  }
  return null;
}

async function syncSubscription(subscription: Stripe.Subscription) {
  const customerId = typeof subscription.customer === 'string'
    ? subscription.customer
    : subscription.customer.id;
  const userId = subscription.metadata?.supabase_user_id || await userIdForCustomer(customerId);
  if (!userId) return;

  const currentPeriodEnd = subscription.items.data[0]?.current_period_end;

  await admin.from('payment_profiles').upsert({
    user_id: userId,
    stripe_customer_id: customerId,
    stripe_subscription_id: subscription.id,
    subscription_status: subscription.status,
    current_plan: subscription.metadata?.product_name || 'Online Coaching',
    current_period_end: currentPeriodEnd ? new Date(currentPeriodEnd * 1000).toISOString() : null,
    updated_at: new Date().toISOString(),
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const signature = req.headers.get('stripe-signature');
  if (!signature) return new Response('Missing Stripe signature', { status: 400 });

  try {
    const body = await req.text();
    const event = await stripe.webhooks.constructEventAsync(body, signature, webhookSecret);

    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;
        const userId = session.client_reference_id || session.metadata?.supabase_user_id;
        if (!userId) break;

        const productKey = session.metadata?.product_key || 'unknown';
        const productName = session.metadata?.product_name || 'Training Purchase';
        const sessions = Number(session.metadata?.sessions_total || 0) || null;
        const customerId = typeof session.customer === 'string' ? session.customer : null;
        const subscriptionId = typeof session.subscription === 'string' ? session.subscription : null;
        const paymentIntentId = typeof session.payment_intent === 'string' ? session.payment_intent : null;

        await admin.from('payment_profiles').upsert({
          user_id: userId,
          stripe_customer_id: customerId,
          updated_at: new Date().toISOString(),
        });

        await admin.from('purchases').upsert({
          user_id: userId,
          stripe_customer_id: customerId,
          stripe_checkout_session_id: session.id,
          stripe_payment_intent_id: paymentIntentId,
          stripe_subscription_id: subscriptionId,
          product_key: productKey,
          product_name: productName,
          payment_type: session.mode === 'subscription' ? 'subscription' : 'one_time',
          status: session.payment_status === 'paid' ? 'paid' : 'complete',
          amount_total: session.amount_total || 0,
          currency: session.currency || 'usd',
          sessions_total: sessions,
          sessions_remaining: sessions,
          updated_at: new Date().toISOString(),
        }, { onConflict: 'stripe_checkout_session_id' });

        if (subscriptionId) {
          const subscription = await stripe.subscriptions.retrieve(subscriptionId);
          await syncSubscription(subscription);
        }
        break;
      }

      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        await syncSubscription(event.data.object as Stripe.Subscription);
        break;
      }

      case 'invoice.paid':
      case 'invoice.payment_failed': {
        const invoice = event.data.object as Stripe.Invoice;
        const subscriptionId = typeof invoice.parent?.subscription_details?.subscription === 'string'
          ? invoice.parent.subscription_details.subscription
          : null;
        if (subscriptionId) {
          const subscription = await stripe.subscriptions.retrieve(subscriptionId);
          await syncSubscription(subscription);
        }
        break;
      }
    }

    return new Response(JSON.stringify({ received: true }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error(error);
    return new Response(`Webhook error: ${error instanceof Error ? error.message : 'Unknown error'}`, {
      status: 400,
    });
  }
});
