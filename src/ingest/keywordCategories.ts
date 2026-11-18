/**
 * Built-in index of the default categories → words and merchant names that mean them, for rows the
 * card company didn't categorize (bank rows have no category at all; Max puts many rows under "שונות").
 * Names are the default tree's (migration 14) and are looked up by name / alias at categorize time, so a
 * renamed or merged category still works and a category the household deleted is simply skipped.
 *
 * Order matters: the first entry whose category fits the row's sign wins, so specific entries
 * ("ביטוח לאומי", "סופר פארם", "הלוואת רכב") come before the general ones ("ביטוח", "סופר", "הלוואה").
 *
 * A keyword matches whole words of the normalized description (`normalizeDescription`: lower case,
 * quotes dropped so ע"ר → ער and בע"מ → בעמ, other punctuation → space). A Hebrew keyword may carry
 * one prefix letter when it has 3+ letters (ו ה ב ל מ ש כ: "למים", "מכספומט"; not "ער" → "שער"). A keyword ending in `*` matches the start of
 * a word ("alipay*" → "ALIPAYSINGA").
 */
export const KEYWORD_CATEGORIES: [category: string, keywords: string[]][] = [
  // income (used only for money coming in)
  ['משכורת', ['משכורת', 'משכורות', 'שכר עבודה', 'מלגת אברך', 'מלגת כולל']],
  ['דיבידנדים', ['דיבידנד']],
  ['הכנסות', ['ביטוח לאומי', 'בטוח לאומי', 'קצבת', 'קיצבת', 'קצבה', 'מענק', 'החזר מס', 'ריבית', 'רווחים', 'יתרת זכות']],

  // loans before fees, so "ריבית בהלוואה" is the loan
  ['הלוואת רכב', ['הלוואת רכב', 'הלוואה לרכב']],
  ['הלוואות ומשכנתא', ['הלוואה', 'הלוואת', 'הלוואות', 'משכנתא', 'משכנתה', 'לווים']],

  // taxes, fines, fees
  ['תשלום דוחות', ['דוח חניה', 'דוחות חניה', 'קנס', 'קנסות', 'רשות האכיפה', 'גביית קנסות']],
  ['מיסים, דוחות ועמלות', ['ביטוח לאומי', 'בטוח לאומי', 'מס הכנסה', 'רשות המסים', 'מס במקור', 'מס על', 'חיוב מס', 'מעמ', 'אגרה', 'אגרת', 'הוצאה לפועל']],
  ['עמלות אשראי', ['דמי כרטיס', 'עמלת כרטיס', 'עמלת אשראי']],
  ['עמלות בנק', ['עמלת', 'עמלה', 'עמלות', 'דמי ניהול חשבון', 'ריבית', 'משיכת יתר']],

  ['מזומן', ['כספומט', 'משיכת מזומן', 'משיכה מכספומט']],

  // household bills
  ['ארנונה', ['ארנונה']],
  ['מים', ['תאגיד המים', 'תאגיד מים', 'המים והביוב', 'מים וביוב', 'מי ברק', 'מי אביבים', 'הגיחון', 'מי שבע', 'מי כרמל', 'מי רעננה', 'מי מודיעין', 'מי נתניה']],
  ['חשמל', ['חברת החשמל', 'חשמל לישראל', 'חחי', 'אלקטרה פאוור', 'סלקום אנרגיה', 'פזגז חשמל', 'דליה אנרגיות']],
  ['גז', ['אמישראגז', 'אמישרגז', 'פזגז', 'סופרגז', 'דור גז']],
  ['ועד בית', ['ועד בית', 'ועד הבית']],
  ['אינטרנט', ['נטפרי', 'netfree', 'בזק בינלאומי', 'בזק', 'הוט נט', 'אינטרנט']],
  ['טלויזיה ובידור', ['yes', 'יס', 'נטפליקס', 'netflix', 'disney', 'סלקום tv', 'פרטנר tv']],
  ['סלולר', ['פלאפון', 'סלקום', 'פרטנר', 'הוט מובייל', 'גולן טלקום', 'רמי לוי תקשורת', 'וואלה מובייל', 'we4g']],
  ['מנויים ושירותים דיגיטליים', ['google', 'apple', 'itunes', 'icloud', 'microsoft', 'openai', 'chatgpt', 'anthropic', 'claude ai', 'spotify', 'dropbox', 'adobe', 'zoom', 'youtube', 'amazon prime']],

  // insurance: specific before the general word
  ['ביטוח רכב', ['ביטוח רכב', 'ביטוח חובה', 'ביטוח מקיף']],
  ['ביטוחים', ['ביטוח', 'ביטוחים', 'הפניקס', 'מגדל חברה', 'מגדל ביטוח', 'מגדל מקפת', 'הראל ביטוח', 'הראל חברה', 'כלל ביטוח', 'מנורה מבטחים', 'איילון ביטוח', 'הכשרה ביטוח', 'aig']],

  // car and transport
  ['חניונים', ['חניה', 'חנייה', 'חניון', 'חניונים', 'רשות החניה', 'פנגו', 'pango', 'סלופארק', 'cellopark', 'אחוזות החוף']],
  ['דלק וחשמל', ['דלק', 'פז', 'סונול', 'דור אלון', 'ten', 'yellow', 'תחנת דלק']],
  ['תחזוקת רכב', ['מוסך', 'צמיגים', 'פנצריה', 'טסט']],
  ['תחבורה ציבורית', ['רב קו', 'רבקו', 'אגד', 'קווים', 'מטרופולין', 'אפיקים', 'סופרבוס', 'נתיב אקספרס', 'רכבת ישראל', 'מונית', 'מוניות', 'gett', 'יאנגו', 'yango', 'moovit', 'מוביט']],
  ['רכב ותחבורה', ['משרד התחבורה', 'כביש 6', 'דרך ארץ', 'ליסינג']],

  // food and pharmacy: "סופר פארם" before "סופר"
  ['פארם', ['סופר פארם', 'superpharm', 'super pharm', 'בי פארם', 'גוד פארם', 'ניו פארם', 'new pharm', 'בית מרקחת', 'פארם']],
  ['פירות וירקות', ['פירות וירקות', 'ירקות', 'ירקן', 'פירות']],
  ['סופרמרקט', ['שופרסל', 'רמי לוי', 'יוחננוף', 'ויקטורי', 'אושר עד', 'יינות ביתן', 'טיב טעם', 'חצי חינם', 'קרפור', 'carrefour', 'מחסני השוק', 'קשת טעמים', 'סטופ מרקט', 'זול ובגדול', 'יש חסד', 'נתיב החסד', 'ברכל', 'am pm', 'ampm', 'מינימרקט', 'מכולת', 'סופרמרקט', 'סופר']],
  ['אוכל מהיר', ['מקדונלדס', 'mcdonald', 'mcdonalds', 'בורגר', 'בורגראנץ', 'burger', 'פיצה', 'פיצריה', 'pizza', 'דומינוס', 'שווארמה', 'שוארמה', 'פלאפל', 'kfc']],
  ['מסעדות ובילויים', ['מסעדה', 'מסעדת', 'קפה', 'cafe', 'coffee', 'ארומה', 'רולדין', 'לנדוור', 'wolt', 'וולט', 'תן ביס', 'tenbis', 'סיבוס', 'cibus']],

  // health
  ['בריאות', ['בית חולים', 'קופת חולים', 'מכבי', 'כללית', 'מאוחדת', 'לאומית', 'מרפאה', 'מרפאת', 'שיניים', 'שערי צדק', 'מעייני הישועה', 'איכילוב', 'תל השומר', 'אופטיקה', 'משקפיים']],

  // shopping and home
  ['אופנה ביגוד והנעלה', ['ביגוד', 'הלבשה', 'אופנה', 'נעליים', 'נעלי', 'קסטרו', 'fox', 'זארה', 'zara', 'h&m', 'רנואר', 'הודיס', 'שילב', 'טוונטי פור סבן']],
  ['חשמל ואלקטרוניקה', ['ksp', 'אייבורי', 'ivory', 'באג', 'מחסני חשמל', 'שקם אלקטריק', 'אלקטרוניקה', 'מחשבים']],
  ['ריהוט', ['איקאה', 'ikea', 'רהיטים', 'ריהוט']],
  ['שיפוץ ואביזרים לבית', ['הום סנטר', 'home center', 'אייס', 'ace', 'טמבור', 'פטיש', 'כלי עבודה', 'חומרי בניין', 'צבעים']],
  ['תיקונים', ['שרברב', 'אינסטלטור', 'אינסטלציה', 'מנעולן']],
  ['ניקיון', ['ניקיון', 'נקיון']],
  ['שיפוץ, תחזוקה וריהוט הבית', ['הדברה', 'הדברות', 'אחזקה', 'תחזוקה']],
  ['קניות בחו"ל', ['aliexpress', 'alipay*', 'amazon', 'ebay', 'shein', 'temu', 'iherb', 'asos']],

  // family, education, leisure. Schools before the nonprofit marker ע"ר: many schools are nonprofits.
  ['בתי ספר וגנים', ['תלמוד תורה', 'תת', 'גן ילדים', 'גני ילדים', 'גנון', 'בית ספר', 'בית הספר', 'סמינר', 'מעון', 'מעונות', 'צהרון']],
  ['חוגים', ['חוג', 'חוגי', 'חוגים', 'מתנס', 'קונסרבטוריון']],
  ['תרבות ופנאי', ['סטימצקי', 'צומת ספרים', 'ספרים', 'קולנוע', 'סינמה', 'מוזיאון', 'תיאטרון']],
  ['מנוי כושר', ['הולמס פלייס', 'holmes place', 'גו אקטיב', 'go active', 'חדר כושר', 'קאנטרי']],
  ['מספרה', ['מספרה', 'מספרת']],
  ['קוסמטיקה ואביזרי טיפוח', ['קוסמטיקה', 'מניקור', 'פדיקור']],
  ['בעלי חיים', ['וטרינר', 'וטרינרית', 'וטרינרי', 'פט שופ', 'מספוא']],
  ['טיסות', ['אל על', 'el al', 'elal', 'ישראייר', 'ארקיע', 'wizz', 'ryanair', 'easyjet', 'airlines', 'airways', 'טיסה', 'טיסות']],
  ['מלונות', ['מלון', 'hotel', 'hotels', 'booking', 'airbnb', 'צימר', 'צימרים']],
  ['מתנות ואירועים', ['מתנה', 'מתנות', 'פרחים', 'אולמי', 'אולם אירועים']],
  ['תרומה', ['תרומה', 'תרומות', 'צדקה', 'ער', 'ע ר', 'עמותה', 'עמותת', 'קופת העיר', 'קופת רבי מאיר', 'ועד הרבנים', 'עזר מציון', 'יד שרה', 'לב לאחים']],

  // savings plans (bank standing orders)
  ['חסכון חודשי', ['לחיסכון', 'לחסכון', 'הפקדה לפיקדון', 'הפקדה לפקדון']],
];

/** Lower case, quotes dropped (ע"ר → ער), other punctuation → one space. */
export function normalizeDescription(text: string): string {
  return text
    .toLowerCase()
    .replace(/["'`״׳]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function keywordPattern(keyword: string): RegExp {
  const prefixMatch = keyword.endsWith('*');
  const word = normalizeDescription(prefixMatch ? keyword.slice(0, -1) : keyword);
  // one Hebrew prefix letter, only for words long enough not to turn into another word (ער → שער, יס → ביס)
  const prefixLetter = /^[\u0590-\u05FF]/.test(word) && word.length >= 3;
  return new RegExp(`(?:^| )${prefixLetter ? '[ובהלמשכ]?' : ''}${escape(word)}${prefixMatch ? '' : '(?= |$)'}`);
}

const COMPILED = KEYWORD_CATEGORIES.map(([category, keywords]) => ({ category, patterns: keywords.map(keywordPattern) }));

/** The default category names whose keywords appear in the description, in priority order. */
export function keywordCategoryNames(description: string): string[] {
  const text = normalizeDescription(description);
  if (!text) return [];
  return COMPILED.filter(e => e.patterns.some(p => p.test(text))).map(e => e.category);
}
