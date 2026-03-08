-- TowTrack Database Schema
-- Run: psql -U your_user -d towtrack -f schema.sql

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS postgis;

-- Users table (customers + drivers share this)
CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name          VARCHAR(100) NOT NULL,
  email         VARCHAR(255) UNIQUE NOT NULL,
  phone         VARCHAR(20) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role          VARCHAR(10) NOT NULL CHECK (role IN ('customer', 'driver')),
  avatar_url    TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Driver profiles (only for users with role='driver')
CREATE TABLE IF NOT EXISTS driver_profiles (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  vehicle_make    VARCHAR(50) NOT NULL,
  vehicle_model   VARCHAR(50) NOT NULL,
  vehicle_year    VARCHAR(4) NOT NULL,
  license_plate   VARCHAR(20) NOT NULL,
  truck_type      VARCHAR(50) DEFAULT 'flatbed',
  is_available    BOOLEAN DEFAULT false,
  is_verified     BOOLEAN DEFAULT false,
  rating          DECIMAL(3,2) DEFAULT 0.00,
  total_jobs      INTEGER DEFAULT 0,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Driver locations (updated in real time via socket)
CREATE TABLE IF NOT EXISTS driver_locations (
  driver_id   UUID PRIMARY KEY REFERENCES driver_profiles(id) ON DELETE CASCADE,
  location    GEOGRAPHY(POINT, 4326),
  heading     FLOAT,
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Tow requests
CREATE TABLE IF NOT EXISTS tow_requests (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  customer_id     UUID NOT NULL REFERENCES users(id),
  driver_id       UUID REFERENCES driver_profiles(id),
  status          VARCHAR(20) DEFAULT 'pending' CHECK (
                    status IN ('pending','accepted','en_route','arrived','in_progress','completed','cancelled')
                  ),
  pickup_lat      DECIMAL(10, 8) NOT NULL,
  pickup_lng      DECIMAL(11, 8) NOT NULL,
  pickup_address  TEXT NOT NULL,
  dest_lat        DECIMAL(10, 8),
  dest_lng        DECIMAL(11, 8),
  dest_address    TEXT,
  vehicle_info    TEXT,
  notes           TEXT,
  estimated_price DECIMAL(10,2),
  final_price     DECIMAL(10,2),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  accepted_at     TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ
);

-- Payments
CREATE TABLE IF NOT EXISTS payments (
  id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  request_id              UUID UNIQUE NOT NULL REFERENCES tow_requests(id),
  stripe_payment_intent   VARCHAR(255),
  amount                  DECIMAL(10,2) NOT NULL,
  status                  VARCHAR(20) DEFAULT 'pending' CHECK (
                            status IN ('pending','processing','completed','failed','refunded')
                          ),
  created_at              TIMESTAMPTZ DEFAULT NOW()
);

-- Reviews
CREATE TABLE IF NOT EXISTS reviews (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  request_id  UUID UNIQUE NOT NULL REFERENCES tow_requests(id),
  reviewer_id UUID NOT NULL REFERENCES users(id),
  driver_id   UUID NOT NULL REFERENCES driver_profiles(id),
  rating      INTEGER CHECK (rating BETWEEN 1 AND 5),
  comment     TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_tow_requests_customer ON tow_requests(customer_id);
CREATE INDEX IF NOT EXISTS idx_tow_requests_driver ON tow_requests(driver_id);
CREATE INDEX IF NOT EXISTS idx_tow_requests_status ON tow_requests(status);
CREATE INDEX IF NOT EXISTS idx_driver_locations_geo ON driver_locations USING GIST(location);
