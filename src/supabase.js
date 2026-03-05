import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://gizlspmxrslxdzvrfpam.supabase.co';
const SUPABASE_KEY = 'sb_publishable_VTSElmNNkSXxr_KcfgWedw_LwgYRiAL';

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
