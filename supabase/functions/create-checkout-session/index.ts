import Stripe from 'npm:stripe@^22';
import { createClient } from 'npm:@supabase/supabase-js@2';
import { corsHeaders } from '../_shared/cors.ts';

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!);

const products = {
  online_monthly: {
    priceId: Deno.env.get('STRIPE_PRICE_ONLINE_MONTHLY'),
    mode: 'subscription',
    name: 'Online Coaching',
    sessions: null,
  },
  single_session: {
    priceId: Deno.env.get('STRIPE_PRICE_SINGLE_SESSION'),
    mode: 'payment',
    name: 'Single In-Person Session',
    sessions: 1,
  },
  four_sessions: {
    priceId: Deno.env.get('STRIPE_PRICE_FOUR_SESSIONS'),
    mode: 'payment',
    name: '4-Session Package',
    sessions: 4,
  },
  eight_sessions: {
    priceId: Deno.env.get('STRIPE_PRICE_EIGHT_SESSIONS'),
    mode: 'payment',
    name: '8-Session Package',
    sessions: 8,
  },
  twelve_sessions: {
    priceId: Deno.env.get('STRIPE_PRICE_TWELVE_SESSIONS'),
    mode: 'payment',
    name: '12-Session Package',
    sessions: 12,
  },
} as const;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) throw new Error('Missing authorization.');

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } },
    );

    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user?.email) throw new Error('Please log in again.');

    const { productKey, successUrl, cancelUrl } = await req.json();
    const product = products[productKey as keyof typeof products];
    if (!product || !product.priceId) throw new Error('This payment option is not configured.');

    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const { data: profile } = await admin
      .from('payment_profiles')
      .select('stripe_customer_id')
      .eq('user_id', user.id)
      .maybeSingle();

    let customerId = profile?.stripe_customer_id || null;

    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        name: user.user_metadata?.full_name || undefined,
        metadata: { supabase_user_id: user.id },
      });
      customerId = customer.id;

      await admin.from('payment_profiles').upsert({
        user_id: user.id,
        stripe_customer_id: customerId,
        updated_at: new Date().toISOString(),
      });
    }

    const session = await stripe.checkout.sessions.create({
      mode: product.mode,
      customer: customerId,
      line_items: [{ price: product.priceId, quantity: 1 }],
      success_url: `${successUrl}${successUrl.includes('?') ? '&' : '?'}session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: cancelUrl,
      client_reference_id: user.id,
      allow_promotion_codes: true,
      billing_address_collection: 'auto',
      metadata: {
        supabase_user_id: user.id,
        product_key: productKey,
        product_name: product.name,
        sessions_total: product.sessions === null ? '' : String(product.sessions),
      },
      subscription_data: product.mode === 'subscription' ? {
        metadata: {
          supabase_user_id: user.id,
          product_key: productKey,
          product_name: product.name,
        },
      } : undefined,
    });

    return new Response(JSON.stringify({ url: session.url }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : 'Checkout failed.' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
