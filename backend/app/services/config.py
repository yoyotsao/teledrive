from functools import lru_cache
from pydantic_settings import BaseSettings, SettingsConfigDict
from typing import Optional


class Settings(BaseSettings):
    # Telegram API (REQUIRED)
    telegram_api_id: int
    telegram_api_hash: str
    
    # Telegram Session String (REQUIRED for MTProto uploads)
    telegram_session_string: Optional[str] = None
    
    # Bot Token (Optional - not needed for MTProto direct uploads)
    telegram_bot_token: Optional[str] = None
    
    # Server
    backend_host: str = "0.0.0.0"
    backend_port: int = 8000
    
    # Upload settings
    max_file_size: int = 2 * 1024 * 1024 * 1024  # 2GB default
    chunk_size: int = 10 * 1024 * 1024  # 10MB chunks
    
    # CORS
    cors_origins: list = ["*"]
    
    # File storage (in-memory for demo, use database in production)
    enable_memory_storage: bool = True
    
    model_config = SettingsConfigDict(
        env_file="../.env",
        env_file_encoding="utf-8",
        extra="ignore",
    )


@lru_cache()
def get_settings() -> Settings:
    return Settings()
