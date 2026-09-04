import { createClient } from '@supabase/supabase-js';
import supabaseConfig from './supabaseConfig.json';

export const SUPABASE_URL = supabaseConfig.url;
const SUPABASE_KEY = supabaseConfig.publishableKey;

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
