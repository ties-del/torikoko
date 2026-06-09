import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://xbzyefidtqphakavkwda.supabase.co';
const SUPABASE_KEY = 'sb_publishable_ZuNGZGdRuoGlebOt8qmncw_xTY3tf2y';

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
