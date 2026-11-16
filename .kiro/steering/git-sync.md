---
inclusion: always
---

# 🔴 חוק ברזל – סנכרון גיט: הכול ב-`main`

המשתמש אינו מתכנת ואינו מתעסק עם GitHub. בסוף כל משימה הקוד חייב להיות בענף `main` שבשרת, כדי שיהיה תמיד מאגר
אחד מעודכן שאפשר למשוך ממנו למחשב, בלי עותקים שונים ובלי ענפים שנשארים פתוחים.
**משימה אינה גמורה עד שהשינוי נמצא ב-`origin/main`.** (החלטת המשתמש, 16.11.2026)

- המאגר: `origin` ← `https://github.com/imreykodesh/familycfo`.
- `main` הוא הענף היחיד שנשאר לאורך זמן. **במחשב** עובדים ישירות עליו. **בענן** עובדים על ענף משימה זמני וממזגים
  אותו דרך PR **מיד** אחרי שהבדיקות עברו בסביבה.
- commit, push ומיזוג ל-`main` לפי הכללים כאן **מאושרים מראש**. האישור לא כולל פרסום גרסה (תגית `v*`).
- לפני שמתחילים: לבדוק את **כל** הענפים בשרת (`git ls-remote --heads origin`), לא רק את `main` וה-PRs. ענף שיש בו
  עבודה שלא במיין — לשאול את המשתמש לפני שבונים משהו מקביל.

## 🔴 אימות = `npm run check`, בלי בנייה

לפני כל commit מריצים בסביבה עצמה `npm run check` (התקנה אם חסר → typecheck של ה-API, הדסקטופ והממשק → בדיקות).
בדיקה שנכשלת – מתקנים לפני ה-commit. אם אי אפשר להריץ – לדווח למשתמש ולא למזג.
**לא** בונים קובץ התקנה לצורך אימות, ולא מחכים ל-GitHub Actions ולא מתנים בו מיזוג. בנייה ופרסום – רק כשהמשתמש מבקש במפורש.

## GitHub Actions

`.github/workflows/desktop.yml` רץ רק על תגית `v*` או ידנית (`workflow_dispatch`) — לא על כל push. לא להוסיף הפעלה
אוטומטית על push או PR בלי אישור המשתמש.

## `git-sync.cmd` / `git-sync.ps1`

סנכרון דו-כיווני של הענף הנוכחי (משיכה, ואם יש מה לדחוף – גם דחיפה; קונפליקט צפוי → עוצר לפני שנוגע בקבצים).
הם של המשתמש: לא למחוק, ולשנות רק לפי בקשתו המפורשת.

## זיהוי הסביבה

- **מקומית**: Windows, המחשב של המשתמש.
- **ענן**: כל סביבה אחרת (Kiro בענן, Codespace וכו'), שבה יש גישה רק לגיט.

## במחשב המקומי: ישר ל-`main`

בתחילת משימה:
```bash
git fetch origin
git checkout main
git pull --ff-only origin main
```
אם ה-pull נכשל, או שיש שינויים מקומיים שמתנגשים – לעצור ולדווח. לא לדרוס ולא למחוק.

בסוף משימה:
1. `npm run check`
2. `git status --short --untracked-files=all`, ולהוסיף את הקבצים ששונו לפי שם (`git add -- <קבצים>`).
3. ```bash
   git commit -m "<תיאור קצר באנגלית>"
   git pull --no-rebase origin main
   git push origin main
   ```
4. לוודא ש-`git status -sb` מראה `## main...origin/main` בלי ahead/behind.

## בענן: ענף משימה ← בדיקות ← PR ← מיזוג מיד

בתחילת משימה:
```bash
git fetch origin
git checkout -B task/<תיאור-קצר> origin/main
```

בסוף משימה:
1. `npm run check`.
2. ```bash
   git commit -m "<תיאור קצר באנגלית>"
   git push -u origin task/<תיאור-קצר>
   ```
3. PR ל-`main`, כותרת ותיאור בעברית פשוטה: מה השתנה למשתמש ומה נבדק.
   `POST https://api.github.com/repos/imreykodesh/familycfo/pulls` עם `head`, `base=main`, `title`, `body`
   (או `gh pr create -R imreykodesh/familycfo --base main --head task/<תיאור-קצר> ...`).
4. **מיזוג מיד**: `PUT https://api.github.com/repos/imreykodesh/familycfo/pulls/<מספר>/merge` עם `merge_method=merge`.
   - לא ניתן למזג כי `main` התקדם: `git fetch origin && git merge origin/main` לתוך ענף המשימה, `npm run check` שוב, push, מיזוג.
   - קונפליקט: לפתור רק כשברור איך לשלב את שני הצדדים, להריץ `npm run check`; אחרת `git merge --abort` ולדווח.
5. מחיקת ענף המשימה (`git push origin --delete task/<תיאור-קצר>`), ווידוא ש-`origin/main` מכיל את השינוי.

## ענפים

ענפי משימה לא נשארים. בסוף משימה `git branch -r` צריך להראות רק `origin/main` (ואת `origin/desktop-export` כל עוד
המחשב של המשתמש עדיין עובד עליו — הוא מוחזק זהה ל-`main` עד שהמחשב יעבור ל-`main`).
