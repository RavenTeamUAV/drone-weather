# ============================================================
#  Drone Weather — Makefile
#  Використання: make <команда>
# ============================================================

.PHONY: help setup start stop restart logs build docker docker-stop clean

# За замовчуванням — показати довідку
help:
	@echo ""
	@echo "  Drone Weather — команди:"
	@echo ""
	@echo "  make setup       — встановити залежності (npm install)"
	@echo "  make start       — запустити локально (Node.js, порт 3000)"
	@echo "  make stop        — зупинити локальний сервер"
	@echo "  make restart     — перезапустити локальний сервер"
	@echo ""
	@echo "  make docker      — зібрати та запустити через Docker"
	@echo "  make docker-stop — зупинити Docker контейнер"
	@echo "  make logs        — переглянути логи Docker контейнера"
	@echo ""
	@echo "  make clean       — видалити node_modules"
	@echo ""

# ─── ЛОКАЛЬНИЙ ЗАПУСК (Node.js) ─────────────────────────────

setup:
	npm install

start:
	@echo "→ Запуск Drone Weather на http://localhost:3000"
	node server.js

stop:
	@pkill -f "node server.js" && echo "✓ Сервер зупинено" || echo "Сервер не запущено"

restart: stop
	@sleep 1
	$(MAKE) start

# ─── DOCKER ─────────────────────────────────────────────────

docker:
	@echo "→ Збірка та запуск Docker контейнера..."
	docker compose up --build -d
	@echo ""
	@echo "✓ Запущено! Відкрийте: http://localhost:3000"

docker-stop:
	docker compose down
	@echo "✓ Контейнер зупинено"

logs:
	docker compose logs -f

clean:
	rm -rf node_modules
	@echo "✓ node_modules видалено"
