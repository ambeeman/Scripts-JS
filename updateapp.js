const express = require('express')
const cors = require('cors')
const { createHandler } = require('graphql-http/lib/use/http')
const config = require('./config')
const schema = require('./schema.graphql')
const sequelize = require('./sequelize')
const { Op, Sequelize } = require('sequelize')
const { Telegraf } = require('telegraf')
const { io: socketClient } = require('socket.io-client')
const processingTonPayments = require('./functions/processingTonPayments')
const updateTONCurrency = require('./functions/updateTONCurrency')
const cron = require('node-cron')
const addBalance = require('./functions/addBalance')
const fs = require('fs')
const { Markup } = require('telegraf')
const path = require('path')
const moment = require('moment-timezone')

/* Models */
const {
	UsersModel,
	StarsTransactionsModel,
	DonationsListModel,
	DonationsHistoryModel,
	AdsHistoryModel,
	DailyRaffleUsersModel,
	LoginSessionsModel,
} = require('./models.sequelize')

/* Memory */
const { socketIoUsers } = require('./memory/socketIoUsers')
const telegramBot = require('./memory/telegram.bot')
const raffleWinner = require('./functions/raffleWinner')

/* Telegram Main Bot */
telegramBot.bot = new Telegraf(config.BOT_TOKEN)
telegramBot.session = telegramBot.bot?.telegram

/* Telegram Stars */
telegramBot.bot.on('pre_checkout_query', async ctx => {
	const { id, total_amount, invoice_payload } = ctx.preCheckoutQuery
	const json_invoice_payload = JSON.parse(invoice_payload)
	if (!json_invoice_payload.stars_transaction_unique)
		return await telegramBot.session
			.answerPreCheckoutQuery(
				id,
				false,
				'Some parameters were passed incorrectly'
			)
			.catch(err => err)
	const stars_transaction = await StarsTransactionsModel.findOne({
		where: {
			unique: json_invoice_payload.stars_transaction_unique,
			status: 0,
		},
	})
	if (!stars_transaction)
		return await telegramBot.session
			.answerPreCheckoutQuery(
				id,
				false,
				'Some parameters were passed incorrectly'
			)
			.catch(err => err)
	const donation = await DonationsListModel.findOne({
		where: {
			id: stars_transaction.payload.donation_id,
			stars: total_amount,
			status: 1,
		},
	})
	if (!donation)
		return await telegramBot.session
			.answerPreCheckoutQuery(
				id,
				false,
				'Some parameters were passed incorrectly'
			)
			.catch(err => err)
	const user = await UsersModel.findOne({
		where: {
			id: stars_transaction.user_id,
		},
	})
	if (!user)
		return await telegramBot.session
			.answerPreCheckoutQuery(
				id,
				false,
				'Some parameters were passed incorrectly'
			)
			.catch(err => err)
	return telegramBot.session.answerPreCheckoutQuery(id, true).catch(err => err)
})
telegramBot.bot.on('successful_payment', async ctx => {
	const successful_payment = ctx.update.message.successful_payment
	const { total_amount, invoice_payload, telegram_payment_charge_id } =
		successful_payment
	const json_invoice_payload = JSON.parse(invoice_payload)
	if (!json_invoice_payload.stars_transaction_unique) return
	const stars_transaction = await StarsTransactionsModel.findOne({
		where: {
			unique: json_invoice_payload.stars_transaction_unique,
			status: 0,
		},
	})
	if (!stars_transaction) return
	const donation = await DonationsListModel.findOne({
		where: {
			id: stars_transaction.payload.donation_id,
			stars: total_amount,
			status: 1,
		},
	})
	if (!donation) return
	const user = await UsersModel.findOne({
		where: {
			id: stars_transaction.user_id,
		},
	})
	if (!user) return
	await stars_transaction.update({
		payment_charge_id: telegram_payment_charge_id,
		status: 1,
	})
	await DonationsHistoryModel.create({
		user_id: user.id,
		donation_id: donation.id,
		stars_transaction_id: stars_transaction.id,
		price: donation.price,
	})
	return await addBalance('vTono', stars_transaction.user_id, donation.vTono)
})

/* Telegram Start Command */
telegramBot.session.setWebhook('', {
	drop_pending_updates: true,
})
telegramBot.bot.use((ctx, next) => {
	if (ctx.from === undefined || ctx.chat === undefined) return
	if (ctx.update !== undefined && ctx.update.callback_query !== undefined) {
		if (ctx.update.callback_query.data === 'none') return next()
	}
	return ctx.from.id === ctx.chat.id && next()
})
telegramBot.bot.start(ctx => {
	const friendCode = ctx.message.text.replace('/start', '').slice(1)
	let gameDomain = config.GAME_DOMAIN
	if (friendCode) {
		gameDomain += '?friendCode=' + friendCode
	}
	return ctx.replyWithPhoto(config.CDN_LINK + '/bot-start-image.png', {
		caption: fs.readFileSync(
			path.resolve(__dirname, './start-message.txt'),
			'UTF-8'
		),
		parse_mode: 'HTML',
		...Markup.inlineKeyboard([
			[Markup.button.webApp('🪂 Play for airdrop', gameDomain)],
			[Markup.button.url('Join community', config.TELEGRAM_GROUP)],
		]),
	})
})

/* Telegram Checker Bot */
telegramBot.checker.bot = new Telegraf(config.CHECKER_BOT_TOKEN)
telegramBot.checker.session = telegramBot.checker.bot?.telegram

/* Telegram Chat Delete Join And Leave Messages */
telegramBot.checker.bot.on('message', ctx => {
	if (
		ctx.update?.message?.new_chat_member ||
		ctx.update?.message?.left_chat_member
	) {
		return ctx.deleteMessage(ctx.update.message.id)
	}
})

/* Express and Socket.io */
const app = express(),
	server = require('http').createServer(app),
	io = require('socket.io')(server)

/* Parser TON current to USDT (stable coin) */
cron.schedule('*/5 * * * *', async () => await updateTONCurrency())

/* Daily Raffle Winner Selection */
cron.schedule('0 0 * * *', async () => await raffleWinner(io))

/* After start app update TON currency */
updateTONCurrency()

/* Sequelize MySQL Authenticate */
sequelize
	.authenticate()
	.then(() => {
		console.log('Connected to DB')
	})
	.catch(error => {
		console.error('Unable to connect to the database: ', error)
	})

/* WSS Ton Transactions Checker */
const wssTonTransactions = socketClient(config.WSS_TON_TRANSACTIONS, {
	transports: ['websocket'],
	reconnection: true,
	reconnectionDelay: 3000,
	auth: {
		token: config.WEB3.AUTH_TOKEN,
	},
})

wssTonTransactions.on('connect', () => {
	wssTonTransactions.emit('create-ton-checker', {
		socket_id: wssTonTransactions.id,
		wallet: config.WEB3.TON_CONTRACT_ADDRESS,
	})
	console.log('TON Checker Service connected!')
})
wssTonTransactions.on('connect_error', () =>
	console.log(
		'Whoops.. WSS Ton Checker Service unavailable. Try reconnecting...'
	)
)
wssTonTransactions.on('disconnect', () =>
	console.log('TON Checker Service disconnected!')
)
wssTonTransactions.on('notification', data => console.log(data))
wssTonTransactions.on('transaction', async data => {
	await processingTonPayments(data)
	return wssTonTransactions.emit('add-transaction-to-history', data)
})

const socketIoMiddleware = async (column = 'auth_token', token) => {
	const user = await UsersModel.findOne({ where: { [column]: token } })
	if (!user) return false
	return true
}

io.sockets.on('connection', async function (socket) {
	const token = socket.handshake.auth?.token
	if (!token || token.length !== 96 || !/^[A-Za-z0-9]{96}$/.test(token))
		return await socket.disconnect(true)
	const middlewareUser = await socketIoMiddleware('auth_token', token)
	if (!middlewareUser) {
		socket.emit('game_error', {
			error: true,
			connection_type: 'auth',
			is_multi: false,
			title: 'Error',
			description: 'There was an error on our server side',
			button: { type: 'success', name: 'Refresh app', function: 'reloadApp' },
		})
		return socket.disconnect(true)
	}
	socketIoUsers.push({ token, socket })
	socket.on('disconnect', function () {
		if (!token || socket.disconnected) return
		socketIoUsers.splice(socketIoUsers.indexOf(token), 1)
	})
})
