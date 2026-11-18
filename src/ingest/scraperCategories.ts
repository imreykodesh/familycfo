/**
 * Category names the card companies put on their rows → the default category they mean.
 * Used at categorize time, so it works for any database (migration 14 copied an older list into
 * `category_aliases` only for databases created with the default tree).
 * Max's list: https://onlinelcapi.max.co.il/api/contents/getCategories (22 names, Nov 2026).
 * Names with no clear meaning here (Max "העברת כספים": paying a person can be spend or a transfer) are
 * left out on purpose: those rows stay uncategorized for the user to decide.
 */
export const SCRAPER_CATEGORY_MAP: Record<string, string> = {
  // Max
  'ביטוח': 'ביטוחים', 'דלק, חשמל וגז': 'דלק וחשמל', 'אופנה': 'אופנה ביגוד והנעלה', 'עיצוב הבית': 'שיפוץ ואביזרים לבית',
  'טיסות ותיירות': 'טיסות', 'חשמל ומחשבים': 'חשמל ואלקטרוניקה', 'מזון וצריכה': 'סופרמרקט', 'ספרים ודפוס': 'תרבות ופנאי',
  'פנאי, בידור וספורט': 'תרבות ופנאי', 'תחבורה ורכבים': 'רכב ותחבורה', 'עירייה וממשלה': 'מיסים, דוחות ועמלות',
  'רפואה ובתי מרקחת': 'פארם', 'שירותי תקשורת': 'סלולר', 'שונות': 'אחר', 'מוצרי אשראי m_a_x': 'עמלות אשראי',
  'מוצרי m_a_x': 'עמלות אשראי', 'משיכת מזומן': 'מזומן', 'חיות מחמד': 'בעלי חיים', 'קוסמטיקה וטיפוח': 'קוסמטיקה ואביזרי טיפוח',
  'מסעדות, קפה וברים': 'מסעדות ובילויים', 'מט"ח': 'קניות בחו"ל',
  // Isracard / Cal and older names
  'מזון ומשקאות': 'סופרמרקט', 'מסעדות': 'מסעדות ובילויים', 'מזון מהיר': 'אוכל מהיר', 'רפואה ובריאות': 'בריאות',
  'אנרגיה': 'דלק וחשמל', 'מלונאות ואירוח': 'מלונות', 'תיירות': 'נופש', 'תקשורת ומחשבים': 'חשמל ואלקטרוניקה',
  'ריהוט ובית': 'ריהוט', 'אירועים': 'מתנות ואירועים', 'ילדים': 'חינוך ומשפחה', 'פנאי בילוי': 'מסעדות ובילויים',
};
