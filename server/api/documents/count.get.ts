import { count } from 'drizzle-orm';

import { documents } from '../../db/schema';
import { db } from '../../db';

export default defineEventHandler(async () => {
  const [result] = await db.select({ value: count() }).from(documents);

  return {
    count: result.value
  };
});

