"""
Telegram Cloud Storage - Backend API

FastAPI application for:
- Uploading files to Telegram via Bot API
- Direct downloads from Telegram CDN via MTProto
- File chunking for large files (>2GB)
- Gatekeeper endpoint for secure direct downloads
"""

from contextlib import asynccontextmanager
from fastapi import FastAPI, Request
from fastapi.exception_handlers import http_exception_handler
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.middleware.base import BaseHTTPMiddleware
from loguru import logger
import sys

from app.services.config import get_settings
from app.services.database import get_database, close_database
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
    logger.info(f"Database initialized: {db.db_path}")

    # Startup
    settings = get_settings()
    logger.info(
        f"Server configuration: {settings.backend_host}:{settings.backend_port}"
    )
    logger.info(f"Max file size: {settings.max_file_size / (1024**3):.2f} GB")
    logger.info(f"Chunk size: {settings.chunk_size / (1024**2):.2f} MB")

    yield

    # Shutdown
    logger.info("Shutting down Telegram Cloud Storage API...")
    await close_database()
    logger.info("Database connection closed")


# Create FastAPI application
app = FastAPI(
    title="Telegram Cloud Storage API",
    description="""
    A proxy backend for Telegram Cloud Storage.
    
    ## Features:
    - **Upload**: Upload files to Telegram via Bot API
    - **Download**: Direct downloads from Telegram CDN (bypasses GCP egress)
    - **Chunking**: Support for files >2GB via chunked uploads
    - **Gatekeeper**: Secure time-limited download links
    
    ## Architecture:
    - Uploads: Client -> Our Server -> Telegram Bot API
    - Downloads: Client -> Gatekeeper -> Telegram CDN (direct)
    
    This architecture avoids GCP egress charges by having
    the browser download directly from Telegram's CDN.
    """,
    version="1.0.0",
    lifespan=lifespan,
)


# Configure CORS
settings = get_settings()
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# No-cache middleware to prevent browser caching
class NoCacheMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
        return response


app.add_middleware(NoCacheMiddleware)


# Include routers
app.include_router(router)


# Health check endpoint
@app.get("/health")
async def health_check():
    """Health check endpoint."""
    return {
        "status": "healthy",
        "service": "Telegram Cloud Storage API",
        "version": "1.0.0",
    }


# Root endpoint
@app.get("/")
async def root():
    """Root endpoint with API information."""
    return {
        "name": "Telegram Cloud Storage API",
        "version": "1.0.0",
        "docs": "/docs",
        "endpoints": {
            "upload_init": "POST /api/v1/upload/init",
            "upload_chunk": "POST /api/v1/upload/chunk/{file_id}",
            "upload_simple": "POST /api/v1/upload/simple",
            "list_files": "GET /api/v1/files",
            "get_file": "GET /api/v1/files/{file_id}",
            "delete_file": "DELETE /api/v1/files/{file_id}",
            "download": "GET /api/v1/download/{file_id}",
            "gatekeeper": "GET /api/v1/download/gatekeeper/{file_id}",
            "create_link": "POST /api/v1/download/gatekeeper",
        },
    }


# Exception handlers
@app.exception_handler(StarletteHTTPException)
async def http_exception_handler_with_logging(
    request: Request, exc: StarletteHTTPException
):
    """Log every 5xx HTTPException with the traceback of what actually failed.

    Routes report internal errors as `raise HTTPException(500, str(e))` from inside an
    `except` block. That strips the traceback from the response but Python still keeps
    the original exception on `__context__`, so we can recover it here instead of
    adding a logger call to all 14 raise sites (and every future one).

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
        status_code=500, content={"error": "Internal server error", "detail": str(exc)}
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
