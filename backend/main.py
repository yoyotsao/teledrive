"""TeleDrive metadata and authentication API.

Telegram file bytes travel directly between the browser's GramJS client and
Telegram.  This process stores only SQLite metadata and never proxies files.
"""

from contextlib import asynccontextmanager
from fastapi import FastAPI, Request
from fastapi.exception_handlers import http_exception_handler
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.middleware.base import BaseHTTPMiddleware
from loguru import logger
import asyncio
import sys

from app.services.config import get_settings
from app.services.database import get_database, close_database
from app.services import bot_challenge
from app.api.routes import router


# Configure logging
logger.remove()
logger.add(
    sys.stderr,
    format="<green>{time:YYYY-MM-DD HH:mm:ss}</green> | <level>{level: <8}</level> | <cyan>{name}</cyan>:<cyan>{function}</cyan>:<cyan>{line}</cyan> - <level>{message}</level>",
    level="INFO",
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan - startup and shutdown."""
    logger.info("Starting Telegram Cloud Storage API...")
    logger.info("Initializing services...")

    # Initialize database
    logger.info("Initializing SQLite database...")
    db = await get_database()
    logger.info("SQLite metadata database initialized")

    # Startup
    settings = get_settings()
    logger.info(
        f"Server configuration: {settings.backend_host}:{settings.backend_port}"
    )

    # Bot-challenge login: one global getUpdates cursor for the whole process.
    poll_task = None
    if settings.telegram_bot_token:
        try:
            await bot_challenge.init()
            poll_task = asyncio.create_task(bot_challenge.poll_loop())
        except Exception as e:
            # A bad token must not take the whole API down — /auth/challenge 503s instead.
            logger.error(f"Bot challenge login unavailable: {e}")
    else:
        logger.warning("TELEGRAM_BOT_TOKEN not set — /auth/challenge will return 503")

    yield

    # Shutdown
    logger.info("Shutting down Telegram Cloud Storage API...")
    if poll_task:
        poll_task.cancel()
    await close_database()
    logger.info("Database connection closed")


# Create FastAPI application
app = FastAPI(
    title="TeleDrive Metadata API",
    description="""
    Authenticates Telegram users and stores per-drive SQLite metadata.
    File transfers are handled only by GramJS in the browser.
    """,
    version="1.0.0",
    lifespan=lifespan,
)


# Configure CORS
settings = get_settings()
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=False,
    allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
)


# No-cache middleware to prevent browser caching
class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
        response.headers["Cross-Origin-Resource-Policy"] = "same-origin"
        return response


app.add_middleware(SecurityHeadersMiddleware)


# Include routers
app.include_router(router)


# Health check endpoint
@app.get("/health")
async def health_check():
    """Health check endpoint."""
    return {
        "status": "healthy",
        "service": "TeleDrive Metadata API",
        "version": "1.0.0",
    }


# Root endpoint
@app.get("/")
async def root():
    """Root endpoint with API information."""
    return {
        "name": "TeleDrive Metadata API",
        "version": "1.0.0",
        "docs": "/docs",
        "endpoints": {
            "auth_challenge": "POST /api/v1/auth/challenge",
            "register_metadata": "POST /api/v1/files/register",
            "list_files": "GET /api/v1/files",
            "get_file": "GET /api/v1/files/{file_id}",
            "trash_file": "DELETE /api/v1/files/{file_id}",
            "purge_metadata": "DELETE /api/v1/files/{file_id}/purge",
        },
    }


# Exception handlers
@app.exception_handler(StarletteHTTPException)
async def http_exception_handler_with_logging(
    request: Request, exc: StarletteHTTPException
):
    """Log every 5xx HTTPException with the traceback of what actually failed.

    Route-level 5xx responses are deliberately generic. Python still keeps the
    original exception on `__context__`, allowing internal diagnostics without
    disclosing database paths or exception messages to API callers.

    Without this, a 500 leaves nothing behind but a uvicorn access line: 199 of them on
    2026-08-01 turned out to be a dead `./backend` bind mount, and the only trace of
    `unable to open database file` was in the response body sent to the browser.
    """
    if exc.status_code >= 500:
        original = exc.__cause__ or exc.__context__
        logger.opt(exception=original or exc).error(
            f"{exc.status_code} on {request.method} {request.url.path}: {exc.detail}"
        )
    return await http_exception_handler(request, exc)


@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    """Global exception handler."""
    logger.opt(exception=exc).error(
        f"Unhandled exception on {request.method} {request.url.path}: {exc}"
    )
    return JSONResponse(
        status_code=500, content={"detail": "Internal server error"}
    )


if __name__ == "__main__":
    import uvicorn

    settings = get_settings()

    uvicorn.run(
        "main:app",
        host=settings.backend_host,
        port=settings.backend_port,
        reload=False,
        log_level="info",
    )
