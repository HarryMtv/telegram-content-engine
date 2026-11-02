-- Время последней неудачной попытки опроса источника.
-- Нужно, чтобы (а) не долбить упавший источник каждый тик — last_ok_at при
-- ошибке не двигается, и источник остаётся «просроченным» ежеминутно;
-- (б) периодически возвращать dead-источники на повторную попытку
-- (openspec/specs/source-adapters/spec.md → сценарий «Automatic Health Recovery»):
-- внешний API чинится, а сам источник из dead уже не выходит.

ALTER TABLE sources ADD COLUMN last_error_at timestamptz;

-- уже упавшим источникам ставим отсечку, иначе они все разом уйдут в опрос
UPDATE sources SET last_error_at = now() WHERE status = 'dead';
