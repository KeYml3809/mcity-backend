-- Таблица пользователей
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username VARCHAR(50) UNIQUE NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    avatar_url TEXT DEFAULT '/avatars/default.png',
    banner_url TEXT DEFAULT '/banners/default.png',
    role VARCHAR(20) DEFAULT 'user',
    likes_count INT DEFAULT 0,
    created_at TIMESTAMP WITH TIMEZONE DEFAULT CURRENT_TIMESTAMP
);

-- Таблица для отслеживания кулдауна лайков профилей (3 часа)
CREATE TABLE IF NOT EXISTS profile_likes_log (
    id SERIAL PRIMARY KEY,
    from_user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    to_user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMP WITH TIMEZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT unique_recent_like UNIQUE(from_user_id, to_user_id)
);

-- Таблица коллекционных карточек
DO $$ BEGIN
    CREATE TYPE card_rarity AS ENUM ('D', 'C', 'B', 'A', 'S', 'SS');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS cards (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    character_name VARCHAR(100) NOT NULL,
    manga_title VARCHAR(150) NOT NULL,
    image_url TEXT NOT NULL,
    rarity card_rarity NOT NULL DEFAULT 'D',
    drop_rate NUMERIC(5,2) NOT NULL
);

-- Инвентарь пользователей
CREATE TABLE IF NOT EXISTS user_cards (
    id SERIAL PRIMARY KEY,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    card_id INT REFERENCES cards(id) ON DELETE CASCADE,
    obtained_at TIMESTAMP WITH TIMEZONE DEFAULT CURRENT_TIMESTAMP
);

-- Таблица истории выпадения карточек (таймер 10 минут)
CREATE TABLE IF NOT EXISTS card_drop_cooldowns (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    last_drop_at TIMESTAMP WITH TIMEZONE DEFAULT CURRENT_TIMESTAMP
);
