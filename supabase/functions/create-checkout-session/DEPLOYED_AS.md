This folder's code is deployed as the Supabase function **`clever-service`** - that is the name
post-job.html calls (CHECKOUT_FUNCTION_URL). There is no deployed function called
`create-checkout-session`. To deploy:

    copy index.ts to a temp supabase/functions/clever-service/ folder, then
    supabase functions deploy clever-service --project-ref iqcyofkosjopxsfdufvy --use-api

(Checked 2026-11-18: the live clever-service matched this index.ts apart from one comment.)
