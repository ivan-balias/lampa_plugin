(function () {
    'use strict';

    var SITE   = 'https://rezka-ua.co';
    var PLUGIN = 'HDRezka';
    var PROXY  = 'https://api.allorigins.win/raw?url=';

    // ── Мережа ──────────────────────────────────────────────────
    var corsOk = true;

    function fetchGet(url) {
        var direct = function () { return fetch(url).then(function (r) { return r.text(); }); };
        var proxy  = function () { return fetch(PROXY + encodeURIComponent(url)).then(function (r) { return r.text(); }); };
        if (!corsOk) return proxy();
        return direct().catch(function () { corsOk = false; return proxy(); });
    }

    function fetchPost(url, params) {
        var body = Object.keys(params).map(function (k) {
            return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]);
        }).join('&');

        var doPost = function () {
            return fetch(url, {
                method : 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest' },
                body   : body
            }).then(function (r) { return r.json(); });
        };
        var doGet = function () {
            return fetch(PROXY + encodeURIComponent(url + '?' + body)).then(function (r) { return r.json(); });
        };

        if (!corsOk) return doGet();
        return doPost().catch(function () { corsOk = false; return doGet(); });
    }

    // ── Парсинг потоків ──────────────────────────────────────────
    function parseStreams(raw) {
        if (!raw) return [];
        // Декодування обфускації Резки
        var decoded = raw;
        try {
            decoded = raw
                .replace(/\/\//g, '/')
                .replace(/\#h/g, '')
                .split('/').filter(Boolean).join('/');
            if (!decoded.startsWith('http')) decoded = raw;
        } catch(e) { decoded = raw; }

        var streams = [];
        var re = /\[([^\]]+)\](https?:\/\/[^\s,\[]+)/g;
        var m;
        while ((m = re.exec(decoded)) !== null) {
            streams.push({ label: m[1], url: m[2].split(' or ')[0] });
        }
        if (!streams.length && /https?:\/\//.test(decoded)) {
            streams.push({ label: 'Auto', url: decoded.trim().split(' or ')[0] });
        }
        var order = ['2160p', '1080p Ultra', '1080p', '720p', '480p', '360p', 'Auto'];
        streams.sort(function (a, b) {
            var ai = order.indexOf(a.label);
            var bi = order.indexOf(b.label);
            return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
        });
        return streams;
    }

    // ── Парсинг сторінки тайтлу ──────────────────────────────────
    function parsePage(html) {
        var d = new DOMParser().parseFromString(html, 'text/html');

        var idM = html.match(/initCDN(?:Series|Movie)Events\((\d+)[,\s]/) ||
                  html.match(/"id_post"[:\s"]+(\d+)/);
        var titleId = idM ? idM[1] : '';

        var isSeries = !!d.querySelector('.b-simple_season__item');

        var translators = [];
        d.querySelectorAll('.b-translators__item, .b-translator__item').forEach(function (el) {
            var tid = el.dataset.translatorId || el.dataset.translator_id;
            if (tid) translators.push({ id: tid, name: el.textContent.trim() });
        });
        if (!translators.length) {
            var tm = html.match(/translator_id['":\s]+(\d+)/);
            if (tm) translators.push({ id: tm[1], name: 'Оригінал' });
        }

        var seasons = [];
        d.querySelectorAll('.b-simple_season__item').forEach(function (el) {
            seasons.push({ id: el.dataset.tab, name: el.textContent.trim() });
        });

        return { titleId: titleId, isSeries: isSeries, translators: translators, seasons: seasons };
    }

    // ── Пошук на Резці ───────────────────────────────────────────
    function searchRezka(query) {
        var url = SITE + '/search/?do=search&subaction=search&q=' + encodeURIComponent(query);
        return fetchGet(url).then(function (html) {
            var d = new DOMParser().parseFromString(html, 'text/html');
            var items = [];
            d.querySelectorAll('.b-content__inline_item').forEach(function (el) {
                var a   = el.querySelector('a.b-content__inline_item-link');
                var img = el.querySelector('img');
                if (!a) return;
                var hm = (a.href || '').match(/\/(\d+)-/);
                var tv = a.querySelector('div');
                items.push({
                    id    : hm ? hm[1] : '',
                    title : tv ? tv.textContent.trim() : a.textContent.trim(),
                    poster: img ? img.src : '',
                    url   : a.href
                });
            });
            return items;
        });
    }

    // ── Список епізодів ──────────────────────────────────────────
    function getEpisodes(titleId, translatorId, season) {
        return fetchPost(SITE + '/ajax/get_cdn_series/', {
            id: titleId, translator_id: translatorId,
            season: season, episode: 1, action: 'get_episodes'
        }).then(function (data) {
            if (!data.episodes) return [];
            var d = new DOMParser().parseFromString(data.episodes, 'text/html');
            var eps = [];
            d.querySelectorAll('.b-simple_episode__item').forEach(function (el) {
                eps.push({ id: el.dataset.episode, name: el.textContent.trim() });
            });
            return eps;
        });
    }

    // ── Відео-стрім ──────────────────────────────────────────────
    function getStream(titleId, translatorId, season, episode, isSeries) {
        var p = { id: titleId, translator_id: translatorId };
        var endpoint;
        if (isSeries) {
            p.season  = season;
            p.episode = episode;
            p.action  = 'get_stream';
            endpoint  = '/ajax/get_cdn_series/';
        } else {
            p.action = 'get_movie';
            endpoint = '/ajax/get_cdn_movie/';
        }
        return fetchPost(SITE + endpoint, p).then(function (data) {
            if (!data.success) throw new Error(data.message || 'API error');
            return parseStreams(data.url);
        });
    }

    // ── Відображення інтерфейсу плагіна ─────────────────────────
    function RezkaComponent(object) {
        var card   = object.card;
        var comp   = object.component;

        var html   = $('<div class="rezka-wrap"></div>');
        var search_query = (card.original_title || card.title || '').toLowerCase();

        // Показуємо лоадер
        var loader = $('<div class="broadcast__scan"><div></div></div>');
        html.append(loader);

        // Поточний стан UI
        var state = {
            results   : [],
            selected  : null,  // вибраний результат з Резки
            rezka     : null,  // розпарсена сторінка
            translators: [],
            seasons   : [],
            episodes  : [],
            curTranslator: null,
            curSeason : null,
        };

        function showError(msg) {
            html.empty();
            html.append('<div class="empty"><div class="empty__img"></div><div class="empty__title">' + msg + '</div></div>');
        }

        function renderResults(items) {
            html.empty();
            if (!items.length) { showError('Нічого не знайдено на HDRezka'); return; }

            var title = $('<div class="rezka-section-title" style="color:var(--color-second);margin-bottom:1em;font-size:1.2em;">Результати пошуку на HDRezka</div>');
            html.append(title);

            var list = $('<div class="rezka-list" style="display:flex;flex-wrap:wrap;gap:1em;"></div>');
            items.forEach(function (item) {
                var el = $('<div class="card selector" style="width:120px;cursor:pointer;text-align:center;"></div>');
                var img = $('<img style="width:120px;height:170px;object-fit:cover;border-radius:4px;" />');
                img.attr('src', item.poster || '');
                var name = $('<div style="font-size:0.8em;margin-top:0.3em;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;">' + item.title + '</div>');
                el.append(img).append(name);
                el.on('click', function () { loadTitle(item); });
                list.append(el);
            });
            html.append(list);

            // Фокус на першому елементі
            Lampa.Controller.enable('content');
        }

        function loadTitle(item) {
            html.empty();
            html.append('<div class="broadcast__scan"><div></div></div>');

            fetchGet(item.url).then(function (pageHtml) {
                state.selected = item;
                state.rezka    = parsePage(pageHtml);
                state.translators = state.rezka.translators;
                state.seasons     = state.rezka.seasons;
                state.curTranslator = state.translators[0] || { id: '0', name: 'Авто' };

                if (state.rezka.isSeries) {
                    loadSeason(state.seasons[0] || { id: '1', name: 'Сезон 1' });
                } else {
                    playMovie();
                }
            }).catch(function (e) {
                showError('Помилка завантаження: ' + e.message);
            });
        }

        function loadSeason(season) {
            state.curSeason = season;
            html.empty();
            html.append('<div class="broadcast__scan"><div></div></div>');

            var r  = state.rezka;
            var tid = state.curTranslator.id;

            getEpisodes(r.titleId, tid, season.id).then(function (eps) {
                state.episodes = eps;
                renderEpisodes(season);
            }).catch(function (e) {
                showError('Помилка отримання епізодів: ' + e.message);
            });
        }

        function renderEpisodes(season) {
            html.empty();

            // Рядок з перекладачами (якщо є кілька)
            if (state.translators.length > 1) {
                var tWrap = $('<div style="margin-bottom:0.8em;"></div>');
                tWrap.append('<span style="color:var(--color-second);margin-right:0.5em;">Переклад:</span>');
                state.translators.forEach(function (t) {
                    var btn = $('<span class="selector" style="margin-right:0.5em;padding:0.2em 0.6em;border-radius:4px;cursor:pointer;">' + t.name + '</span>');
                    if (t.id === state.curTranslator.id) btn.css('background', 'var(--color-second)');
                    btn.on('click', function () {
                        state.curTranslator = t;
                        loadSeason(state.curSeason);
                    });
                    tWrap.append(btn);
                });
                html.append(tWrap);
            }

            // Рядок з сезонами
            if (state.seasons.length > 1) {
                var sWrap = $('<div style="margin-bottom:0.8em;"></div>');
                sWrap.append('<span style="color:var(--color-second);margin-right:0.5em;">Сезон:</span>');
                state.seasons.forEach(function (s) {
                    var btn = $('<span class="selector" style="margin-right:0.5em;padding:0.2em 0.6em;border-radius:4px;cursor:pointer;">' + s.name + '</span>');
                    if (s.id === season.id) btn.css('background', 'var(--color-second)');
                    btn.on('click', function () { loadSeason(s); });
                    sWrap.append(btn);
                });
                html.append(sWrap);
            }

            // Список епізодів
            var epTitle = $('<div style="color:var(--color-second);margin-bottom:0.5em;">' + season.name + '</div>');
            html.append(epTitle);

            if (!state.episodes.length) {
                html.append('<div style="opacity:0.6;">Епізоди не знайдено</div>');
                return;
            }

            var epList = $('<div style="display:flex;flex-wrap:wrap;gap:0.5em;"></div>');
            state.episodes.forEach(function (ep) {
                var btn = $('<span class="selector" style="padding:0.4em 0.8em;border-radius:4px;cursor:pointer;border:1px solid var(--color-second);">' + ep.name + '</span>');
                btn.on('click', function () { playEpisode(ep); });
                epList.append(btn);
            });
            html.append(epList);

            Lampa.Controller.enable('content');
        }

        function playMovie() {
            var r   = state.rezka;
            var tid = state.curTranslator.id;

            html.empty();
            html.append('<div class="broadcast__scan"><div></div></div>');

            getStream(r.titleId, tid, 1, 1, false).then(function (streams) {
                if (!streams.length) { showError('Потоки не знайдено'); return; }
                startPlay(streams);
            }).catch(function (e) {
                showError('Помилка отримання потоку: ' + e.message);
            });
        }

        function playEpisode(ep) {
            var r   = state.rezka;
            var tid = state.curTranslator.id;
            var sid = state.curSeason ? state.curSeason.id : 1;

            html.empty();
            html.append('<div class="broadcast__scan"><div></div></div>');

            getStream(r.titleId, tid, sid, ep.id, true).then(function (streams) {
                if (!streams.length) { showError('Потоки не знайдено'); return; }
                startPlay(streams);
            }).catch(function (e) {
                showError('Помилка отримання потоку: ' + e.message);
            });
        }

        function startPlay(streams) {
            var quality = {};
            streams.forEach(function (s) { quality[s.label] = s.url; });

            Lampa.Player.play({
                url      : streams[0].url,
                title    : card.title || card.original_title || '',
                quality  : quality,
                subtitles: []
            });

            Lampa.Player.playlist([{
                url      : streams[0].url,
                title    : card.title || card.original_title || '',
                quality  : quality,
                subtitles: []
            }]);
        }

        // ── Старт: пошук ────────────────────────────────────────
        searchRezka(search_query).then(function (items) {
            state.results = items;

            // Якщо є точний збіг за назвою — одразу завантажуємо
            var exact = items.find(function (i) {
                return i.title.toLowerCase() === search_query;
            });

            if (exact) {
                loadTitle(exact);
            } else {
                renderResults(items);
            }
        }).catch(function (e) {
            showError('Помилка пошуку: ' + e.message);
        });

        // ── Публічний інтерфейс компонента ──────────────────────
        this.render = function () { return html; };
        this.start  = function () { Lampa.Controller.enable('content'); };
        this.pause  = function () {};
        this.stop   = function () {};
        this.destroy= function () { html.remove(); };
    }

    // ── Реєстрація ───────────────────────────────────────────────
    function register() {
        if (typeof Lampa === 'undefined') {
            return setTimeout(register, 300);
        }

        // Реєструємо компонент
        Lampa.Component.add('rezka', RezkaComponent);

        // Додаємо кнопку "HDRezka" у деталях картки
        Lampa.Listener.follow('full', function (e) {
            if (e.type !== 'complite') return;

            var button = $('<div class="full-start selector" style="margin-left:0.5em;">'
                + '<svg height="28" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>'
                + '<span style="margin-left:0.3em;">HDRezka</span>'
                + '</div>');

            button.on('click', function () {
                Lampa.Activity.push({
                    url      : '',
                    title    : 'HDRezka',
                    component: 'rezka',
                    card     : e.object.card,
                    page     : 1
                });
            });

            // Вставляємо кнопку після кнопки "Дивитись"
            var watchBtn = e.object.activity.render().find('.full-start').first();
            if (watchBtn.length) {
                watchBtn.after(button);
            } else {
                e.object.activity.render().find('.full-details').append(button);
            }
        });

        console.log('[HDRezka] Плагін завантажено ✓');
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', register);
    } else {
        register();
    }

})();
