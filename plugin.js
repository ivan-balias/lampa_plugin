(function () {
    'use strict';

    // ============================================================
    //  КОНФІГУРАЦІЯ
    // ============================================================
    var SITE_URL   = 'https://rezka-ua.co';
    var PLUGIN_ID  = 'HDRezka';
    var PROXY_URL  = 'https://api.allorigins.win/raw?url='; // CORS-проксі для веб-браузера

    // ============================================================
    //  МЕРЕЖЕВИЙ ШАР (авто-вибір прямий / через проксі)
    // ============================================================
    var _corsMode = 'direct'; // 'direct' | 'proxy'

    function rawFetch(url, options) {
        return fetch(url, options);
    }

    // POST через URLSearchParams — вживається для AJAX-ендпоінтів Rezka
    function postForm(path, params) {
        var url     = SITE_URL + path;
        var body    = new URLSearchParams(params).toString();
        var headers = {
            'Content-Type'     : 'application/x-www-form-urlencoded',
            'X-Requested-With' : 'XMLHttpRequest',
            'Referer'          : SITE_URL + '/'
        };

        var doRequest = function (useProxy) {
            var finalUrl = useProxy ? PROXY_URL + encodeURIComponent(url) : url;
            return fetch(finalUrl, {
                method  : useProxy ? 'GET' : 'POST',    // allorigins підтримує лише GET
                headers : useProxy ? {} : headers,
                // Якщо проксі — параметри в URL (обмеження allorigins для POST)
            }).then(function (r) { return r.json(); });
        };

        if (_corsMode === 'proxy') return doRequest(true);

        return doRequest(false).catch(function () {
            _corsMode = 'proxy';
            // Для POST через проксі — конвертуємо в GET з параметрами в URL
            var fullUrl = url + '?' + body;
            return fetch(PROXY_URL + encodeURIComponent(fullUrl)).then(function (r) { return r.json(); });
        });
    }

    // GET HTML — для парсингу сторінок
    function getHTML(url) {
        var doRequest = function (useProxy) {
            var finalUrl = useProxy ? PROXY_URL + encodeURIComponent(url) : url;
            return fetch(finalUrl).then(function (r) { return r.text(); });
        };

        if (_corsMode === 'proxy') return doRequest(true);

        return doRequest(false).catch(function () {
            _corsMode = 'proxy';
            return doRequest(true);
        });
    }

    // ============================================================
    //  ПАРСИНГ ПОТОКІВ
    //  Формат: [360p]url1:hls:manifest.m3u8 or [720p]url2...
    //  Або просто пряме MP4-посилання
    // ============================================================
    function parseStreams(urlString) {
        if (!urlString) return [];
        var streams = [];
        // Декодуємо якщо є HTML-entities або percent-encoding
        var decoded = urlString.replace(/&#(\d+);/g, function (_, code) {
            return String.fromCharCode(parseInt(code));
        });

        var regex = /\[([^\]]+)\](https?:\/\/[^\s,\[]+)/g;
        var match;
        while ((match = regex.exec(decoded)) !== null) {
            var streamUrl = match[2].replace(/:hls:manifest\.m3u8$/, ':hls:manifest.m3u8');
            // Замінюємо or-дзеркала — беремо перший CDN
            streamUrl = streamUrl.split(' or ')[0];
            streams.push({ label: match[1], url: streamUrl });
        }

        // Якщо нічого не знайшли — можливо це пряме MP4
        if (!streams.length && decoded.match(/https?:\/\//)) {
            var cleanUrl = decoded.split(' or ')[0].trim();
            streams.push({ label: 'Auto', url: cleanUrl });
        }

        // Сортуємо: найкраща якість першою
        var order = ['2160p', '1080p Ultra', '1080p', '720p', '480p', '360p', 'Auto'];
        streams.sort(function (a, b) {
            var ai = order.indexOf(a.label);
            var bi = order.indexOf(b.label);
            if (ai === -1) ai = 99;
            if (bi === -1) bi = 99;
            return ai - bi;
        });
        return streams;
    }

    // ============================================================
    //  ПОШУК
    // ============================================================
    function search(query, page) {
        var url = SITE_URL + '/search/?do=search&subaction=search&q=' +
                  encodeURIComponent(query) + '&page=' + (page || 1);

        return getHTML(url).then(function (html) {
            var parser = new DOMParser();
            var doc    = parser.parseFromString(html, 'text/html');
            var items  = [];

            doc.querySelectorAll('.b-content__inline_item').forEach(function (el) {
                var link  = el.querySelector('a.b-content__inline_item-link');
                var img   = el.querySelector('img');
                var info  = el.querySelector('.b-content__inline_item-link div');
                if (!link) return;

                var hrefMatch = (link.href || '').match(/\/(\d+)-([^\/]+)\.html/);
                var id        = hrefMatch ? hrefMatch[1] : '';
                var slug      = hrefMatch ? hrefMatch[2] : '';

                // Визначаємо тип: серіал, аніме, фільм
                var type = 'movie';
                var genres = el.querySelector('.b-content__inline_item-category');
                if (genres) {
                    var g = genres.textContent.toLowerCase();
                    if (g.indexOf('аніме') !== -1 || g.indexOf('anime') !== -1) type = 'anime';
                    else if (g.indexOf('серіал') !== -1 || g.indexOf('serial') !== -1) type = 'series';
                }
                // Якщо slug містить відповідні слова
                if (slug.indexOf('serial') !== -1 || slug.indexOf('series') !== -1) type = 'series';
                if (slug.indexOf('anime') !== -1 || slug.indexOf('аніме') !== -1) type = 'anime';

                var titleEl = link.querySelector('div');
                items.push({
                    id    : id,
                    title : titleEl ? titleEl.textContent.trim() : link.textContent.trim(),
                    year  : info ? info.textContent.trim() : '',
                    poster: img ? img.src : '',
                    url   : link.href,
                    type  : type
                });
            });

            return items;
        });
    }

    // ============================================================
    //  ПАРСИНГ СТОРІНКИ ТАЙТЛУ (озвучки, сезони, ID)
    // ============================================================
    function parseTitlePage(html) {
        var parser = new DOMParser();
        var doc    = parser.parseFromString(html, 'text/html');

        // ID тайтлу
        var idMatch = html.match(/initCDN(?:Series|Movie)Events\((\d+),/);
        if (!idMatch) idMatch = html.match(/"id_post":\s*(\d+)/);
        var titleId = idMatch ? idMatch[1] : '';

        // Визначаємо чи це серіал/аніме
        var isSeries = !!doc.querySelector('.b-simple_season__item');

        // Озвучки
        var translators = [];
        doc.querySelectorAll('.b-translators__item, .b-translator__item').forEach(function (el) {
            var tid = el.dataset.translatorId || el.dataset.translator_id;
            if (!tid) return;
            translators.push({
                id   : tid,
                name : el.textContent.trim()
            });
        });

        // Якщо жодної озвучки не знайшли — шукаємо вбудовану
        if (!translators.length) {
            var m = html.match(/translator_id['":\s]+(\d+)/);
            if (m) translators.push({ id: m[1], name: 'Оригінал' });
        }

        // Сезони
        var seasons = [];
        doc.querySelectorAll('.b-simple_season__item').forEach(function (el) {
            seasons.push({
                id  : el.dataset.tab || el.dataset.id,
                name: el.textContent.trim()
            });
        });

        return { titleId: titleId, translators: translators, seasons: seasons, isSeries: isSeries };
    }

    function getTitleData(titleUrl) {
        return getHTML(titleUrl).then(parseTitlePage);
    }

    // ============================================================
    //  СПИСОК ЕПІЗОДІВ
    // ============================================================
    function getEpisodes(titleId, translatorId, season) {
        return postForm('/ajax/get_cdn_series/', {
            id           : titleId,
            translator_id: translatorId,
            season       : season,
            episode      : 1,
            action       : 'get_episodes'
        }).then(function (data) {
            if (!data.episodes) return [];
            var parser = new DOMParser();
            var doc    = parser.parseFromString(data.episodes, 'text/html');
            var eps    = [];
            doc.querySelectorAll('.b-simple_episode__item').forEach(function (el) {
                eps.push({
                    id  : el.dataset.episode,
                    name: el.textContent.trim()
                });
            });
            return eps;
        });
    }

    // ============================================================
    //  ОТРИМАННЯ ВІДЕО-ПОТОКУ
    // ============================================================
    function getStream(titleId, translatorId, season, episode, isSeries) {
        var params = {
            id           : titleId,
            translator_id: translatorId,
            action       : isSeries ? 'get_stream' : 'get_movie'
        };
        if (isSeries) {
            params.season  = season;
            params.episode = episode;
        }

        var path = isSeries ? '/ajax/get_cdn_series/' : '/ajax/get_cdn_movie/';

        return postForm(path, params).then(function (data) {
            if (!data.success) throw new Error(data.message || 'API помилка');
            return parseStreams(data.url);
        });
    }

    // ============================================================
    //  КАТЕГОРІЇ (головна сторінка)
    // ============================================================
    function getCategory(path) {
        return getHTML(SITE_URL + path).then(function (html) {
            var parser = new DOMParser();
            var doc    = parser.parseFromString(html, 'text/html');
            var items  = [];
            doc.querySelectorAll('.b-content__inline_item').forEach(function (el) {
                var link  = el.querySelector('a.b-content__inline_item-link');
                var img   = el.querySelector('img');
                if (!link) return;
                var hrefMatch = (link.href || '').match(/\/(\d+)-/);
                var titleEl   = link.querySelector('div');
                items.push({
                    id    : hrefMatch ? hrefMatch[1] : '',
                    title : titleEl ? titleEl.textContent.trim() : '',
                    poster: img ? img.src : '',
                    url   : link.href,
                    type  : 'movie'
                });
            });
            return items;
        });
    }

    // ============================================================
    //  LAMPA PLUGIN
    // ============================================================
    var component = {

        // ----------------------------------------------------------
        //  Пошук
        // ----------------------------------------------------------
        search: function (params, oncomplete, onerror) {
            search(params.query, 1)
                .then(function (items) {
                    oncomplete(items.map(component._toCard));
                })
                .catch(onerror);
        },

        // ----------------------------------------------------------
        //  Конвертація у Lampa-картку
        // ----------------------------------------------------------
        _toCard: function (item) {
            return {
                id          : 'rezka_' + item.id,
                _rezka_id   : item.id,
                _rezka_url  : item.url,
                _rezka_type : item.type,
                title       : item.title,
                original_title: item.title,
                poster      : item.poster,
                poster_path : item.poster,
                year        : item.year,
                source      : PLUGIN_ID
            };
        },

        // ----------------------------------------------------------
        //  Деталі картки (сезони / озвучки)
        // ----------------------------------------------------------
        full: function (card, oncomplete, onerror) {
            getTitleData(card._rezka_url || card.url)
                .then(function (data) {
                    card._rezka        = data;
                    card._rezka_type   = data.isSeries ? 'series' : card._rezka_type;
                    oncomplete(card);
                })
                .catch(onerror);
        },

        // ----------------------------------------------------------
        //  Список сезонів (для серіалів/аніме)
        // ----------------------------------------------------------
        seasons: function (card, oncomplete, onerror) {
            var rezka = card._rezka;
            if (!rezka) {
                return component.full(card, function () {
                    component.seasons(card, oncomplete, onerror);
                }, onerror);
            }
            oncomplete(rezka.seasons.length ? rezka.seasons : [{ id: '1', name: 'Сезон 1' }]);
        },

        // ----------------------------------------------------------
        //  Список епізодів
        // ----------------------------------------------------------
        episodes: function (card, season, oncomplete, onerror) {
            var rezka        = card._rezka;
            var translatorId = rezka.translators.length ? rezka.translators[0].id : '0';

            getEpisodes(rezka.titleId, translatorId, season.id)
                .then(oncomplete)
                .catch(onerror);
        },

        // ----------------------------------------------------------
        //  Вибір озвучки → повертає список
        // ----------------------------------------------------------
        translators: function (card, oncomplete) {
            var rezka = card._rezka;
            if (rezka && rezka.translators.length) {
                oncomplete(rezka.translators);
            } else {
                oncomplete([{ id: '0', name: 'Авто' }]);
            }
        },

        // ----------------------------------------------------------
        //  Відтворення
        // ----------------------------------------------------------
        play: function (card, params, oncomplete, onerror) {
            var rezka        = card._rezka;
            var isSeries     = card._rezka_type === 'series' || card._rezka_type === 'anime';
            var translatorId = (params.translator && params.translator.id) ||
                               (rezka && rezka.translators.length ? rezka.translators[0].id : '0');
            var season       = params.season  ? params.season.id  : 1;
            var episode      = params.episode ? params.episode.id : 1;

            getStream(rezka.titleId, translatorId, season, episode, isSeries)
                .then(function (streams) {
                    if (!streams.length) return onerror('Потоки не знайдено');

                    var quality = {};
                    streams.forEach(function (s) { quality[s.label] = s.url; });

                    oncomplete({
                        url    : streams[0].url,
                        title  : card.title,
                        quality: quality,
                        // Передаємо всі дзеркала для плеєра Lampa
                        timeline: {
                            hash: card._rezka_id + '_' + season + '_' + episode
                        }
                    });
                })
                .catch(onerror);
        },

        // ----------------------------------------------------------
        //  Категорії / рядки головного меню
        // ----------------------------------------------------------
        category: function (params, oncomplete, onerror) {
            var cats = {
                'films'  : '/films/',
                'series' : '/series/',
                'anime'  : '/animation/',
                'new'    : '/new/'
            };
            var path = cats[params.id] || '/';
            getCategory(path)
                .then(function (items) { oncomplete(items.map(component._toCard)); })
                .catch(onerror);
        }
    };

    // ============================================================
    //  РЕЄСТРАЦІЯ В LAMPA
    // ============================================================

    // Спробуємо обидва варіанти API — Lampa.Plugin та Lampa.Source
    function registerPlugin() {
        // --- Варіант 1: новий API (Lampa 2.x+) ---
        if (window.Lampa && Lampa.Source) {
            Lampa.Source.add(PLUGIN_ID, {
                name   : 'HDRezka',
                logo   : SITE_URL + '/templates/HdRezka/images/logo.png',
                search : component.search,
                full   : component.full,
                seasons: component.seasons,
                episodes: component.episodes,
                play   : component.play,
                category: component.category
            });
            console.log('[HDRezka] Зареєстровано через Lampa.Source');
        }

        // --- Варіант 2: Lampa.Plugin (класичний) ---
        if (window.Lampa && Lampa.Plugin) {
            Lampa.Plugin.add(PLUGIN_ID, function (plugin) {
                plugin.source = component;

                // Додаємо пункт у меню
                if (Lampa.Menu && Lampa.Menu.add) {
                    Lampa.Menu.add({
                        title : 'HDRezka',
                        icon  : 'search',
                        action: function () {
                            Lampa.Activity.push({
                                url     : '',
                                title   : 'HDRezka',
                                component: 'catalog',
                                source  : PLUGIN_ID,
                                id      : 'films'
                            });
                        }
                    });
                }

                plugin.ready();
                console.log('[HDRezka] Зареєстровано через Lampa.Plugin');
            });
        }

        // --- Варіант 3: якщо Lampa ще не завантажена — чекаємо подію ---
        if (!window.Lampa) {
            document.addEventListener('lampa:ready', registerPlugin);
            console.log('[HDRezka] Очікування Lampa...');
        }
    }

    // ============================================================
    //  ВИБІР ЯКОСТІ / ОЗВУЧКИ — UI хелпери
    // ============================================================

    // Цей блок спрацьовує коли Lampa відкриває картку і запитує озвучки
    function onCardOpened(card) {
        var rezka = card._rezka;
        if (!rezka || !rezka.translators.length) return;

        // Показуємо вибір озвучки через Lampa.Select якщо доступний
        if (!window.Lampa || !Lampa.Select) return;

        Lampa.Select.show({
            title  : 'Озвучка',
            items  : rezka.translators.map(function (t) {
                return { title: t.name, id: t.id };
            }),
            onSelect: function (selected) {
                card._selected_translator = selected;
            }
        });
    }

    // ============================================================
    //  СТАРТ
    // ============================================================
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', registerPlugin);
    } else {
        registerPlugin();
    }

    // Експортуємо для відлагодження
    window._HDRezka = {
        search       : search,
        getTitleData : getTitleData,
        getStream    : getStream,
        parseStreams  : parseStreams
    };

})();
